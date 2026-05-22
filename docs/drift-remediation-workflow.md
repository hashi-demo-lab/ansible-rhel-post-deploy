# Closed-loop drift remediation — TFC × AAP/EDA × ServiceNow

End-to-end technical reference for the workflow that detects out-of-band
changes to vSphere VMs managed by HCP Terraform, opens a ServiceNow
incident + change request for CAB approval, and — once approved —
fires the remediation `terraform apply` automatically through
Event-Driven Ansible (EDA).

This is the doc to read **before** modifying anything. Every moving
part (cloudflare tunnel, port-forward, SN business rule, AAP cred,
ansible.cfg quirk, upstream bug) is captured below so you can pick up
the demo cold.

---

## TL;DR — pre-flight checklist

If you've just opened a fresh session and want to run the demo, verify
the following in order:

| # | Thing | Where to check | Healthy state |
|---|-------|---------------|---------------|
| 1 | TFC → EDA cloudflare tunnel (port 5004) | `app.terraform.io/.../notification-configurations/nc-2Q8Lhk54ahNRVoRd` | URL set, enabled = true |
| 2 | SN → EDA cloudflare tunnel (port 5005) | local `cloudflared` + `oc port-forward` running | tunnel URL responds 200 to `POST /` |
| 3 | EDA activation 17 (`tfc-notification-drift`) | `aap-aap…/decisions/rulebook-activations/17/details` | status `running`, git_hash matches `terraform-eda-example` HEAD |
| 4 | EDA activation 18 (`snow-cr-approval`) | activation 18 details | status `running`, git_hash matches HEAD |
| 5 | AAP project 57 (`ansible-rhel-post-deploy`) | controller projects UI | last sync `successful`, git_hash matches HEAD |
| 6 | Vault paths populated | `secrets/servicenow/dev`, `secrets/tfc/api` | both have non-PLACEHOLDER values |
| 7 | SN business rules in place | dev389292 → `sys_script` | `Notify EDA on CR approval` (single, not duplicate!) + `AAP drift remediation - auto-approve secondary approvers` both `active=true` |
| 8 | SN Outbound REST | dev389292 → `sys_rest_message` | `AAP EDA - CR approval` exists, endpoint = current tunnel #2 URL |

If any of these is off, jump to the relevant component section.

---

## 1. What it does

Banks running RHEL workloads on vSphere need to:

1. **Detect** when someone bypasses Terraform and edits a VM directly
   (vCenter console, vMotion, someone twiddling CPUs in a hurry).
2. **Open** a ticket for the change so audit/CAB has a record.
3. **Authorise** the remediation via the normal CAB approval flow.
4. **Apply** the declared state back over the drift, automatically,
   right after the human approval lands.

## 2. Architecture

```
                                                            ╔═══════════════════════════╗
                                                            ║   HCP Terraform Cloud     ║
                                                            ║  workspace                ║
                                                            ║  better-together-vm-      ║
                                                            ║  lifecycle-dev            ║
                                                            ║  (auto-apply ON)          ║
                                                            ╚═════════╤═════════════════╝
                                                                      │
                              ┌────[1] drift assessment ──────────────┘
                              │       webhook (HMAC-signed)
                              ▼
              ┌───────────────────────────────────────┐
              │ cloudflare tunnel #1 (long-running)   │  https://depot-molecules-award-submit.trycloudflare.com
              │ TFC notif config nc-2Q8Lhk54ahNRVoRd  │
              │ tunnels →  activation 17 webhook:5004 │
              └───────────────┬───────────────────────┘
                              ▼
              ┌───────────────────────────────────────┐
              │ EDA activation #17                    │
              │  tfc-notification-drift               │
              │  rulebook  tfc-notification-rules     │
              │  rule "Drift Detected" →              │
              └───────────────┬───────────────────────┘
                              │ run_job_template
                              ▼
              ┌───────────────────────────────────────┐                ┌───────────────┐
              │ AAP JT 90  drift-create-snow-tickets  │ ─ Vault ─────> │ HashiCorp     │
              │  role: snow_drift_tickets             │ kv_v2 read     │ Vault         │
              │  POSTs incident + Change Request      │                │  /secrets/*   │
              │  + assignment_group=Software          │                └───────┬───────┘
              │  + assigned_to=david.loo              │                        │
              └───────────────┬───────────────────────┘                        │
                              │ REST API                                       │
                              ▼                                                │
              ╔═══════════════════════════════════════╗                        │
              ║ ServiceNow dev389292                  ║                        │
              ║                                       ║                        │
              ║  Incident INC0010xxx                  ║                        │
              ║  Change Request CHG0030xxx (Normal)   ║                        │
              ║   ├─ correlation_id     = ws-…        ║                        │
              ║   ├─ correlation_display = ws name    ║                        │
              ║   ├─ assignment_group = Software      ║                        │
              ║   ├─ assigned_to     = david.loo      ║                        │
              ║   └─ approval state: → not_requested  ║                        │
              ║                                       ║                        │
              ║  Active business rules:               ║                        │
              ║   • Notify EDA on CR approval         ║                        │
              ║     (on change_request, fires on      ║                        │
              ║      approvalCHANGESTOapproved)       ║                        │
              ║   • AAP drift remediation - auto-     ║                        │
              ║     approve secondary approvers       ║                        │
              ║     (on sysapproval_approver, fires   ║                        │
              ║      on insert/update of state)       ║                        │
              ║                                       ║                        │
              ║   [3] Operator clicks Request Approval║                        │
              ║       SN creates ~11 approval records ║                        │
              ║       auto-approve rule resolves      ║                        │
              ║       CAB-group ones, leaves Change   ║                        │
              ║       Manager (david.loo) pending     ║                        │
              ║                                       ║                        │
              ║   [4] Operator clicks Approve         ║                        │
              ║       on david.loo's approval task    ║                        │
              ║       → CR.approval = approved        ║                        │
              ║                                       ║                        │
              ║   [5] Notify EDA business rule fires  ║                        │
              ║       Guards:                         ║                        │
              ║       a) no pending approvals         ║                        │
              ║       b) non-CAB approver found       ║                        │
              ║       resolves approver from          ║                        │
              ║       sysapproval_approver record     ║                        │
              ║       (david.loo / "David Loo")       ║                        │
              ║                                       ║                        │
              ║   POSTs Outbound REST →               ║                        │
              ║   "AAP EDA - CR approval"             ║                        │
              ╚════════════════╤══════════════════════╝                        │
                               │  POST {cr_number,                             │
                               │        correlation_id,                        │
                               │        approver, approver_display, …}         │
                               ▼                                               │
              ┌───────────────────────────────────────┐                        │
              │ cloudflare tunnel #2 (manual)         │                        │
              │  https://*.trycloudflare.com          │                        │
              │  (URL changes on every restart!)      │                        │
              │  tunnels → activation 18 webhook:5005 │                        │
              └───────────────┬───────────────────────┘                        │
                              ▼                                                │
              ┌───────────────────────────────────────┐                        │
              │ EDA activation #18                    │                        │
              │  snow-cr-approval                     │                        │
              │  rulebook  snow-cr-approval-rules     │                        │
              │  rule "CR Approved → trigger apply" → │                        │
              └───────────────┬───────────────────────┘                        │
                              │ run_job_template + extra_vars                  │
                              ▼                                                │
              ┌───────────────────────────────────────┐                        │
              │ AAP JT 91  tfc-trigger-apply          │ ─ Vault ────────────── │
              │  role: tfc_trigger_apply              │ kv_v2 read             │
              │  [a] POST /runs       → create + msg  │                        │
              │  [b] POST /comments   → audit trail   │                        │
              │  [c] poll plan        → wait          │                        │
              │  [d] confirm-apply if needed          │                        │
              │  [e] poll apply       → terminal      │                        │
              └───────────────┬───────────────────────┘                        │
                              │ HCP TF REST API                                │
                              ▼                                                │
                       ╔════════════════╗                                      │
                       ║  HCP Terraform ║ ← run queued, applied                │
                       ║  applies VM    ║   drift reconciled                   │
                       ║  config back   ║                                      │
                       ║  over drift    ║                                      │
                       ╚════════════════╝                                      │
```

## 3. Component inventory

### 3.1 HCP Terraform

| | Value |
|---|---|
| Organization | `tfo-apj-demos` |
| Workspace | `better-together-vm-lifecycle-dev` |
| Workspace ID | `ws-JxUw2w1CoWwCRwZe` |
| Auto-apply | **true** — runs apply automatically once plan succeeds |
| Notification config | `EDA drift notification` (id `nc-2Q8Lhk54ahNRVoRd`) <br>triggers: `assessment:drifted` <br>destination URL: cloudflare tunnel #1 |
| Health assessments | required (this is what produces the `assessment:drifted` event) |

### 3.2 Cloudflare tunnels (two of them)

Both are `trycloudflare.com` **quick tunnels** — free, no Cloudflare
account required, BUT **ephemeral**. The URL changes every time
`cloudflared` is restarted.

| # | Direction | Public URL (current) | Tunnels to | Used by |
|---|-----------|----------------------|------------|---------|
| 1 | TFC → EDA | `https://depot-molecules-award-submit.trycloudflare.com` | activation 17 webhook source, port 5004 (HMAC) | TFC workspace notification config `nc-2Q8Lhk54ahNRVoRd` |
| 2 | SN → EDA | `https://guns-plains-main-grocery.trycloudflare.com` (will change on restart) | activation 18 webhook source, port 5005 (no auth) | SN Outbound REST Message `AAP EDA - CR approval` |

**How tunnel #2 is set up** (the one you'll most likely have to
restart):

```bash
# 1. Find the activation-job pod for activation 18 (pod name changes
#    every time the activation restarts)
POD=$(oc -n aap get pods -o name | grep activation-job-18 | head -1 | sed 's|pod/||')

# 2. Port-forward 5005 from that pod (kill any existing first)
pkill -f 'port-forward.*5005'
oc -n aap port-forward pod/$POD 5005:5005 &

# 3. Start the cloudflare quick tunnel against localhost:5005
cloudflared tunnel --url http://localhost:5005

# Note the new https://*.trycloudflare.com URL it prints, then update
# the SN Outbound REST Message endpoint:
curl -u "admin:pwKi%D6I9-Ja" -X PATCH \
  https://dev389292.service-now.com/api/now/table/sys_rest_message/20cbe2f8938583105e8930018bba103b \
  -H 'Content-Type: application/json' \
  -d "{\"rest_endpoint\": \"<new-url>\"}"
```

Both `cloudflared` processes must stay running for the loop to work.
For a long demo session, run them in `tmux` / `screen` or move to a
named Cloudflare tunnel.

### 3.3 AAP / EDA — IDs

| Object | Type | ID | Notes |
|--------|------|----|----|
| `ansible-rhel-post-deploy` | AAP project | 57 | Source `github.com/hashi-demo-lab/ansible-rhel-post-deploy` |
| `terraform_eda_run_task` | EDA project | 1 | Source `github.com/tfo-apj-demos/terraform-eda-example` |
| Execution Environment | AAP EE | 4 | `quay.io/aaroneautomate/hashi-demo-ee:latest` — has `community.hashi_vault`, `community.vmware` |
| GCVE Decision Environment | EDA DE | 3 | Used by EDA activations |
| `HashiCorp Vault Access` | AAP cred | 19 | AppRole — injects `role_id` / `secret_id` env vars |
| `Local Automation Hub` | AAP cred | 27 | Galaxy NG token at `/api/galaxy/v3/auth/token/` — attached to org 1's `galaxy_credentials` |
| `AAP` | EDA cred | 7 | "Red Hat AAP" credential — lets EDA call the AAP controller |
| `drift-create-snow-tickets` | AAP JT | 90 | inventory 363 baked in, Vault cred 19 attached |
| `tfc-trigger-apply` | AAP JT | 91 | inventory 363 baked in, Vault cred 19 attached |
| `tfc-notification-rules.yaml` | EDA rulebook | 4 | Drift Detected rule fires JT 90 |
| `snow-cr-approval-rules.yaml` | EDA rulebook | 11 | CR Approved rule fires JT 91 |
| `tfc-notification-drift` | EDA activation | 17 | Uses rulebook 4, webhook on port 5004, HMAC validated |
| `snow-cr-approval` | EDA activation | 18 | Uses rulebook 11, webhook on port 5005 |

### 3.4 ServiceNow dev389292

URL: `https://dev389292.service-now.com`  
Admin login: `admin / pwKi%D6I9-Ja` (dev only — public PDI)

| Object | Type | sys_id | Notes |
|--------|------|--------|----|
| `AAP EDA - CR approval` | Outbound REST Message | `20cbe2f8938583105e8930018bba103b` | endpoint = tunnel #2 URL |
| POST function | sys_rest_message_fn | `46db6e3c938583105e8930018bba103f` | body sends `cr_number`, `cr_sys_id`, `correlation_id`, `workspace_name`, `approver`, `approver_display`, `approval_state` |
| `Content-Type: application/json` header | sys_rest_message_fn_headers | `12db6e3c938583105e8930018bba1048` | on the POST function |
| **`Notify EDA on CR approval`** | Business Rule (sys_script) | `611c66f8938583105e8930018bba101f` | table `change_request`, `when: after`, `action_update: true`, filter `approvalCHANGESTOapproved`. Body has TWO guards (see § 5.1) |
| **`AAP drift remediation - auto-approve secondary approvers`** | Business Rule (sys_script) | `e15213f4938983105e8930018bba101b` | table `sysapproval_approver`, when `after`, filter `state=requested`. Auto-approves CAB-group approvers on drift CRs |
| Normal change model | chg_model | `007c4001c343101035ae3f52c1d3aeb2` | OOTB — used as `chg_model` on drift CRs |
| Software group | sys_user_group | `8a4dde73c6112278017a6a4baf547aa7` | default `assignment_group` for drift CRs |
| David Loo | sys_user | `5137153cc611227c000bbd1bd8cd2007` | default `assigned_to` for drift CRs; also the configured Change Manager approver on Normal CRs |
| CAB Approval group | sys_user_group | `b85d44954a3623120004689b2d5dd60a` | members get the CAB approval task; the auto-approve rule resolves them automatically |

> **Don't duplicate the business rules.** Earlier we accidentally had
> two active `Notify EDA on CR approval` rules — the V1 (using
> `gs.getUserName()`) plus the upgraded V3 (with guards). That caused
> the **4 EDA fires per CR approval** symptom. Always update via
> PATCH against the known sys_ids; if you ever do create a duplicate,
> delete it with:
> ```
> curl -u admin:... -X DELETE \
>   https://dev389292.service-now.com/api/now/table/sys_script/<dup-sys-id>
> ```

### 3.5 HashiCorp Vault

Two KV v2 paths the playbooks read at runtime via the AppRole the
`HashiCorp Vault Access` AAP cred provides:

| Path | Shape | Read by | Used for |
|------|-------|---------|---------|
| `secrets/servicenow/dev` | `{ username, password }` | `snow_drift_tickets` role | basic auth to SN REST API |
| `secrets/tfc/api` | `{ token }` | `tfc_trigger_apply` role | bearer token for HCP TF API |

The `ansible` AppRole has the `read_kv` policy (`secrets/data/*`)
attached, so no policy changes were required — only populating the
two paths.

Both paths are managed by Terraform in `terraform-vsphere-vault-config`
(`secrets_kv.tf`) with `ignore_changes = [data_json]` so manual edits
to the secret bodies via the Vault UI aren't reverted on the next
workspace apply.

> Vault also hosts `ldap/creds/vsphere_access` (dynamic LDAP role) for
> the vSphere ops elsewhere in this project — not used by the drift
> remediation flow, but lives in the same Vault instance.

### 3.6 Ansible playbooks & roles

In `hashi-demo-lab/ansible-rhel-post-deploy`:

```
playbooks/
├── drift-create-snow-tickets.yml      ← fires from EDA on drift event (JT 90)
└── tfc-trigger-apply.yml              ← fires from EDA on CR approved (JT 91)
roles/
├── snow_drift_tickets/                ← opens incident + CR in SN
└── tfc_trigger_apply/                 ← creates TFC run, polls, comments
ansible.cfg                            ← contains [galaxy] ignore_certs = true (see § 7.2)
requirements.yml                       ← hashicorp.terraform 2.0.0 (currently unused — see § 9.1)
```

In `tfo-apj-demos/terraform-eda-example`:

```
rulebooks/
├── tfc-notification-rules.yaml        ← used by activation 17
└── snow-cr-approval-rules.yaml        ← used by activation 18
```

## 4. End-to-end flow walkthrough

### Step 1 — drift detection

HCP Terraform runs a health assessment on the workspace (configurable
interval). When the assessment diff > 0, TFC POSTs an HMAC-signed
notification to cloudflare tunnel #1 with `message == "Drift Detected"`.

Sample payload (only the fields we consume):
```json
{
  "message": "Drift Detected",
  "details": {
    "workspace_id":   "ws-JxUw2w1CoWwCRwZe",
    "workspace_name": "better-together-vm-lifecycle-dev",
    "organization_name": "tfo-apj-demos",
    "new_assessment_result": {
      "url": "https://app.terraform.io/api/v2/assessment-results/asmtres-…",
      "resources_drifted": 1
    }
  }
}
```

### Step 2 — EDA receives, fires drift-create-snow-tickets (JT 90)

`tfc-notification-rules.yaml` listens on port 5004 with HMAC validation
(secret `tf_hmac_notification` is on activation 17 as extra_var).

When the `Drift Detected` rule matches, it calls
`run_job_template name: drift-create-snow-tickets` and passes the
workspace_id / name / etc. through `job_args.extra_vars`.

### Step 3 — drift-create-snow-tickets opens incident + CR

The playbook (`hosts: localhost`, `connection: local`) does:

1. `community.hashi_vault.vault_kv2_get` on `secrets/servicenow/dev`.
2. `POST /api/now/table/incident` with workspace context + `correlation_id = workspace_id`.
3. `POST /api/now/table/change_request` similarly. Key fields:
   - `type: normal` (full CAB approval)
   - `correlation_id = workspace_id`
   - `correlation_display = "HCP Terraform workspace <name>"`
   - **`assignment_group = Software`** (pre-populated)
   - **`assigned_to = david.loo`** (pre-populated)

### Step 4 — CAB approval in ServiceNow

The CR appears at `state=New`, `approval=Not Yet Requested`.

> Because `assignment_group` and `assigned_to` are pre-populated, the
> operator can immediately click **Request Approval** with no manual
> form-filling.

When the operator clicks **Request Approval**, SN creates ~11 approval
records in `sysapproval_approver`. Two normally need a human approval:

- **Change Manager** (`david.loo`) — single user
- **CAB Approval group** — one randomly-selected member of the group

The `AAP drift remediation - auto-approve secondary approvers`
business rule fires on each `sysapproval_approver` insert/update,
checks if the approver is in the **CAB Approval** group AND if the
CR's `correlation_id` starts with `ws-`, and if so auto-approves with
a comment trail.

Net result: the operator sees **one** pending approval (Change
Manager / david.loo). One click → CR's `approval` field flips to
`approved`.

### Step 5 — SN business rule fires Outbound REST

The `Notify EDA on CR approval` business rule (filter
`approvalCHANGESTOapproved`) runs the script in § 5.1. After both
guards pass, it POSTs to cloudflare tunnel #2:

```json
{
  "cr_number":         "CHG0030xxx",
  "cr_sys_id":         "...",
  "correlation_id":    "ws-JxUw2w1CoWwCRwZe",
  "workspace_name":    "HCP Terraform workspace better-together-vm-lifecycle-dev",
  "approver":          "david.loo",
  "approver_display":  "David Loo",
  "approval_state":    "approved"
}
```

### Step 6 — EDA receives, fires tfc-trigger-apply (JT 91)

`snow-cr-approval-rules.yaml` listens on port 5005, no auth (dev only).
Rule condition:

```yaml
condition: event.payload.approval_state == "approved" and event.payload.correlation_id is defined
```

On match, fires `run_job_template name: tfc-trigger-apply` with:
- `tfc_workspace_id` ← `event.payload.correlation_id`
- `tfc_run_message` ← interpolated with cr_number + approver_display
- `tfc_approver` ← `event.payload.approver_display | default(event.payload.approver)`
- `tfc_cr_number` ← `event.payload.cr_number`

### Step 7 — tfc-trigger-apply queues the TFC run

The playbook (using direct `ansible.builtin.uri` — see § 9.1):

1. Reads `secrets/tfc/api` from Vault.
2. `POST /api/v2/runs` with `attributes.message = tfc_run_message`.
3. `POST /api/v2/runs/{id}/comments` with structured audit comment.
4. Polls until plan completes.
5. Confirms apply if needed (auto-apply workspaces just return 409).
6. Polls until terminal status.
7. Fails the Ansible job iff final status isn't `applied` /
   `planned_and_finished`.

### Step 8 — TFC applies, drift reconciled

Workspace has `auto-apply = true` → run auto-confirms and applies →
VM module re-applies declared CPU/memory/tags over the drift. End of
loop.

## 5. ServiceNow side — detailed reference

### 5.1 `Notify EDA on CR approval` business rule

| | |
|---|---|
| sys_id | `611c66f8938583105e8930018bba101f` |
| table | `change_request` |
| when | `after` |
| action_update | `true` |
| filter | `approvalCHANGESTOapproved` |

Script:

```javascript
(function executeRule(current, previous) {
  // Guard 1: wait for all approvals on this CR to be resolved.
  // OOTB SN's approval engine flips CR.approval multiple times
  // during the cascade — without this guard the rule fires twice,
  // once with admin/empty and once with the real approver.
  var pending = new GlideRecord('sysapproval_approver');
  pending.addQuery('document_id', current.sys_id);
  pending.addQuery('state', 'requested');
  pending.query();
  if (pending.hasNext()) return;

  // Guard 2: identify the human-actioned approver. CAB-group records
  // are auto-resolved by the other business rule, so the relevant
  // approver is the most recent state=approved sysapproval_approver
  // whose user is NOT in the CAB Approval group.
  var approverName = '', approverDisplay = '';
  var ap = new GlideRecord('sysapproval_approver');
  ap.addQuery('document_id', current.sys_id);
  ap.addQuery('state', 'approved');
  ap.orderByDesc('sys_updated_on');
  ap.query();
  while (ap.next()) {
    var inCab = new GlideRecord('sys_user_grmember');
    inCab.addQuery('user', ap.approver.toString());
    inCab.addQuery('group.name', 'CAB Approval');
    inCab.query();
    if (inCab.hasNext()) continue;
    approverName    = ap.approver.user_name.toString();
    approverDisplay = ap.approver.name.toString();
    break;
  }
  if (!approverName) return;

  // Fire the Outbound REST Message
  var r = new sn_ws.RESTMessageV2('AAP EDA - CR approval', 'post');
  r.setStringParameterNoEscape('cr_number',         current.number.toString());
  r.setStringParameterNoEscape('cr_sys_id',         current.sys_id.toString());
  r.setStringParameterNoEscape('correlation_id',    current.correlation_id.toString());
  r.setStringParameterNoEscape('workspace_name',    current.correlation_display.toString());
  r.setStringParameterNoEscape('approver',          approverName);
  r.setStringParameterNoEscape('approver_display',  approverDisplay);
  r.execute();
})(current, previous);
```

### 5.2 `AAP drift remediation - auto-approve secondary approvers`

| | |
|---|---|
| sys_id | `e15213f4938983105e8930018bba101b` |
| table | `sysapproval_approver` |
| when | `after` |
| action_insert, action_update | `true` |
| filter | `state=requested` |

Auto-approves any sysapproval_approver record where:
- The approver is in the `CAB Approval` group, AND
- The parent CR's `correlation_id` starts with `ws-` (= our drift remediation marker).

That leaves the Change Manager approval task (assigned to a non-CAB
user — david.loo on dev389292) as the **single human click**.

### 5.3 Outbound REST Message body template

Defined on `sys_rest_message_fn` `46db6e3c938583105e8930018bba103f`:

```json
{
  "cr_number":      "${cr_number}",
  "cr_sys_id":      "${cr_sys_id}",
  "correlation_id": "${correlation_id}",
  "workspace_name": "${workspace_name}",
  "approver":       "${approver}",
  "approver_display": "${approver_display}",
  "approval_state": "approved"
}
```

## 6. AAP local Automation Hub — collection install

The `hashicorp.terraform` collection is in `requirements.yml` even
though the role currently uses direct API calls (see § 9.1). The
install path was non-trivial because the collection is NOT on the
public Galaxy NG.

### 6.1 What's in the local AH

| | |
|---|---|
| Local AH root | `https://aap-aap.apps.openshift-01.hashicorp.local/api/galaxy/` |
| Distribution used | `published` (base_path `published`) |
| Namespace | `hashicorp` (created manually for this demo) |
| Collection | `hashicorp.terraform == 2.0.0` (built from `github.com/hashicorp/terraform-ansible-collection` tag 2.0.0) |

### 6.2 How it got there

```bash
# 1. Clone + build the tarball locally
git clone --depth 1 --branch 2.0.0 \
  https://github.com/hashicorp/terraform-ansible-collection.git
cd terraform-ansible-collection
ansible-galaxy collection build --output-path /tmp/ah-build/

# 2. Create the hashicorp namespace in the local AH
curl -k -X POST -H "Authorization: Bearer <aap-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"hashicorp","description":"HashiCorp collections"}' \
  https://aap-aap.apps.openshift-01.hashicorp.local/api/galaxy/_ui/v1/my-namespaces/

# 3. Upload tarball → lands in staging
curl -k -H "Authorization: Bearer <aap-token>" \
  -F "file=@/tmp/ah-build/hashicorp-terraform-2.0.0.tar.gz" \
  https://aap-aap.apps.openshift-01.hashicorp.local/api/galaxy/v3/plugin/ansible/content/published/collections/artifacts/

# 4. Approve via the AH UI (or POST /move/staging/published/)
```

### 6.3 AAP cred + org wiring

For AAP project sync to FIND collections in the local AH, the
following must be in place:

1. **AAP credential** `Local Automation Hub` (id 27), type
   `Ansible Galaxy/Automation Hub API Token`, with:
   - url: `https://aap-aap.apps.openshift-01.hashicorp.local/api/galaxy/content/published/`
   - token: a Galaxy NG token from `POST /api/galaxy/v3/auth/token/`
     (NOT an AAP bearer token — see § 7.3)

2. **Attached to org 1** `galaxy_credentials`:
   ```bash
   curl -k -X POST -H "Authorization: Bearer <aap-token>" \
     -H "Content-Type: application/json" \
     -d '{"id":27}' \
     .../api/controller/v2/organizations/1/galaxy_credentials/
   ```

3. **`[galaxy] ignore_certs = true`** in the project's `ansible.cfg`
   (the cluster uses a self-signed cert — see § 7.2).

## 7. Operational notes / gotchas

### 7.1 Cloudflare tunnel fragility

Both quick tunnels (`*.trycloudflare.com`) survive only while the
`cloudflared` (and the `oc port-forward` it sits behind for #2) is
running. If either dies:

| Broken tunnel | Symptom | Fix |
|---------------|---------|-----|
| #1 (TFC → EDA) | TFC notification delivery failures; no `drift-create-snow-tickets` job in AAP | restart `cloudflared` for port 5004; update the TFC notification config URL via `PATCH /api/v2/notification-configurations/nc-2Q8Lhk54ahNRVoRd` |
| #2 (SN → EDA) | SN syslog shows `AAP EDA webhook fired … status=502`; no `tfc-trigger-apply` job | (a) re-find the activation-18 pod (changes when activation restarts), (b) `oc port-forward` it on 5005, (c) `cloudflared tunnel --url http://localhost:5005`, (d) update the SN Outbound REST Message endpoint via `PATCH /api/now/table/sys_rest_message/20cbe2f8938583105e8930018bba103b` |

### 7.2 Self-signed cluster cert + ansible-galaxy

The AAP cluster uses a self-signed cert. `ansible-galaxy install`
(invoked by project sync) refuses to talk to the local AH with
`CERTIFICATE_VERIFY_FAILED` unless TLS validation is relaxed. The
project's `ansible.cfg` has:

```ini
[galaxy]
ignore_certs = true
```

That's enough — no per-server override needed.

### 7.3 Galaxy NG token vs AAP bearer token

When configuring the `Local Automation Hub` credential's `token`
field, **use a Galaxy NG token** (obtained from
`POST /api/galaxy/v3/auth/token/`), not an AAP bearer token. The
bearer token authenticates against the controller; the Galaxy NG
token authenticates against the AH service. Different auth backends.

### 7.4 Activation restarts change the pod name

`oc port-forward` binds to a specific pod. When activation 18 restarts
(e.g., after a rulebook update or a manual restart), the
activation-job pod is re-created with a new name, the existing
port-forward dies, and tunnel #2 starts returning 502. Find the
current pod and re-run the port-forward:

```bash
POD=$(oc -n aap get pods -o name | grep activation-job-18 | head -1 | sed 's|pod/||')
pkill -f 'port-forward.*5005'
oc -n aap port-forward pod/$POD 5005:5005 &
```

### 7.5 Audit trail surfaces in three places

| System | Audit artefact |
|--------|----------------|
| ServiceNow | Incident + CR with linked `correlation_id`, plus auto-approval comments on each pre-resolved approval task, plus the `gs.info` log entries the business rules emit to `syslog` |
| HCP Terraform | The run's `message` field shows "Drift remediation — ServiceNow CHG… approved by David Loo"; the **Comments** tab carries a structured comment with CR + approver + JT + activation |
| AAP | Job 90 stdout shows the incident + CR numbers; job 91 stdout shows the run id + states + final status |

## 8. Demo dry-run

Pre-flight: TL;DR checklist at the top of this doc ✓

Demo path:

1. **Trigger drift** — change a VM's `num_cpus` directly in vCenter
   (or any out-of-band edit Terraform manages). Wait for the next
   workspace health assessment.
2. TFC POSTs to cloudflare tunnel #1.
3. **AAP — drift-create-snow-tickets job** appears in
   *Automation Execution → Jobs*. Tail the output to see incident
   + CR numbers + their SN URLs printed.
4. **ServiceNow — open the CR** at the URL from the job output.
   `Reconcile VM compute drift via Terraform — <workspace>`,
   `assignment_group = Software`, `assigned_to = david.loo`.
5. Click **Request Approval** → SN creates approval tasks. The
   auto-approve business rule resolves the CAB ones; you see **one**
   pending approval (Change Manager / david.loo).
6. Click **Approve** on that single approval. CR's `approval` field
   flips to `approved`.
7. **AAP — tfc-trigger-apply job** fires almost immediately.
   The job log shows the run id, then the audit comment posted, then
   plan polling, then apply polling, then a final status line.
8. **HCP TF UI** — the workspace shows a new run titled
   *"Drift remediation — ServiceNow CHGxxxxxxx approved by David Loo"*
   with the audit comment visible on the run's Comments tab. The
   apply reconciles the drift.

## 9. Known bugs / workarounds

### 9.1 `hashicorp.terraform.run` silently drops `run_message`

`pytfe.models.RunCreateOptions` has a `message` field with no
`run_message` alias. The Ansible module's argument_spec accepts
`run_message` as a kwarg, builds a dict, and calls
`RunCreateOptions.model_validate(data)`. Pydantic's default
`extra='ignore'` silently drops the unknown kwarg. Result: every run
the module creates lands in TFC with the default `"Triggered via API"`
message — useless for an audit-focused demo.

**Workaround**: the `tfc_trigger_apply` role uses
`ansible.builtin.uri` directly (`POST /runs` with `attributes.message`
in the body). The collection is still in `requirements.yml` so we can
flip back as soon as a release fixes the alias. Issue to be filed
against `github.com/hashicorp/terraform-ansible-collection`.

### 9.2 OOTB approval cascade fires `Notify EDA` multiple times

OOTB SN's approval engine updates the CR's `approval` field multiple
times during the approval cascade (as each approver record resolves).
Each transition matches the `approvalCHANGESTOapproved` filter and
would fire the rule again if unguarded.

**Workaround**: Guard 1 in the notify business rule (§ 5.1) — skip
firing while any sysapproval_approver is still in `requested` state.

### 9.3 Duplicate business rule trap

A previous create attempt left TWO active `Notify EDA on CR approval`
rules (V1 + V3). Both fired on every approval → 4 EDA payloads per
CR. Always check for duplicates after any rule edit:

```bash
curl -u admin:... \
  "https://dev389292.service-now.com/api/now/table/sys_script?sysparm_query=name=Notify%20EDA%20on%20CR%20approval&sysparm_fields=sys_id,active,sys_updated_on" \
  | python3 -m json.tool
# Should return exactly one result (sys_id 611c66f8…)
```

### 9.4 First-fire empty-approver fallback

The very first cascade fire can land before the auto-approve rule has
resolved the secondary CAB approvers. In that window, the loop in the
notify rule finds no non-CAB approver and would otherwise fall through
to a `gs.getUserName()` fallback (returning `admin` / empty display).

**Workaround**: Guard 2 in § 5.1 — start with `approverName = ''`,
walk approvals, and `return` if none is non-CAB. Defers firing until
a second cascade trigger when the data is present.

### 9.5 OOTB Normal change model blocks `Request Approval` without routing fields

Without `assignment_group` and `assigned_to`, the **Request Approval**
UI transition is blocked.

**Workaround**: `snow_drift_tickets` role pre-populates both fields
on CR creation (`Software` group, `david.loo` user). Overridable via
extra_vars.

### 9.6 trycloudflare URLs are ephemeral

Quick tunnel URLs are regenerated on every `cloudflared` restart.
For a persistent demo, set up a named Cloudflare tunnel (free with
an account) or expose the EDA event-stream URLs via an OpenShift
Route and skip cloudflared.

## 10. Quick-lookup configuration reference

**Vault paths**
```
secrets/servicenow/dev   { username, password }
secrets/tfc/api          { token }
```

**ServiceNow Outbound REST body template**
```json
{
  "cr_number":      "${cr_number}",
  "cr_sys_id":      "${cr_sys_id}",
  "correlation_id": "${correlation_id}",
  "workspace_name": "${workspace_name}",
  "approver":       "${approver}",
  "approver_display": "${approver_display}",
  "approval_state": "approved"
}
```

**EDA rulebook conditions**
```yaml
# tfc-notification-rules.yaml
condition: event.payload.message == "Drift Detected" and event.payload.details.new_assessment_result.resources_drifted > 0

# snow-cr-approval-rules.yaml
condition: event.payload.approval_state == "approved" and event.payload.correlation_id is defined
```

**AAP JT inventory**
Both JTs use inventory **363** (`Better Together Demo - …`) so the
launch endpoint accepts the request. The playbooks themselves target
`hosts: localhost` and don't read the inventory's host list.

**Default org galaxy credentials**
```
id=2   Ansible Galaxy        https://galaxy.ansible.com/
id=27  Local Automation Hub  https://aap-aap.apps.openshift-01.hashicorp.local/api/galaxy/content/published/
```

## 11. Backlog / next steps

| Topic | Status | Notes |
|-------|--------|-------|
| Public ingress | Demo-grade (cloudflared quick tunnels) | Replace with named Cloudflare tunnels or OpenShift Routes for production |
| Webhook auth | None on activation 18 | Add basic-auth or HMAC on the `ansible.eda.webhook` source + corresponding profile/headers on the SN Outbound REST Message |
| `hashicorp.terraform.run` adoption | Blocked on upstream `run_message` alias bug | File issue at `github.com/hashicorp/terraform-ansible-collection`; flip role back to module the moment it's fixed |
| Approval gate | Single human click after auto-CAB-resolve | Replace with custom Change Model + single Flow Designer approval step if the auto-resolve hack feels too clever for prod |
| Multi-workspace | Works as-is | `correlation_id = workspace_id` makes the SN→TFC step workspace-agnostic — pointing the TFC notification at the same EDA tunnel from a different workspace just works |
| Run failures | Job fails loudly | `tfc-trigger-apply` exits non-zero on apply failure → visible in AAP. Consider piping that back to SN to re-open the CR with the failure context |
| `before_destroy` / `after_destroy` actions | Not in Terraform 1.14 yet | When they land, hook a `cmdb-close-change` JT into `after_destroy` to close out the CR automatically once the apply succeeds |
