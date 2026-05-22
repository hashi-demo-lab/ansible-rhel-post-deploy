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
| 1 | TFC → EDA cloudflared connector | `oc -n cloudflared-tfc-eda get deploy/cloudflared` | Ready 1/1 |
| 2 | SN → EDA cloudflared connector | `oc -n cloudflared-snow-eda get deploy/cloudflared` | Ready 1/1 |
| 3 | TFC notification URL points at current tunnel #1 URL | TFC notif `nc-2Q8Lhk54ahNRVoRd` ↔ `oc -n cloudflared-tfc-eda logs deploy/cloudflared \| grep trycloudflare` | URLs match, notification enabled = true |
| 4 | SN Outbound REST endpoint points at current tunnel #2 URL | SN `sys_rest_message/20cbe2f8938583105e8930018bba103b` ↔ `oc -n cloudflared-snow-eda logs deploy/cloudflared \| grep trycloudflare` | URLs match |
| 5 | EDA activation 17 (`tfc-notification-drift`) | `aap-aap…/decisions/rulebook-activations/17/details` | status `running`, git_hash matches `terraform-eda-example` HEAD |
| 6 | EDA activation 18 (`snow-cr-approval`) | activation 18 details | status `running`, git_hash matches HEAD |
| 7 | AAP project 57 (`ansible-rhel-post-deploy`) | controller projects UI | last sync `successful`, git_hash matches HEAD |
| 8 | Vault paths populated | `secrets/servicenow/dev`, `secrets/tfc/api` | both have non-PLACEHOLDER values |
| 9 | SN business rules in place | dev389292 → `sys_script` | `Notify EDA on CR approval` (single, not duplicate!) + `AAP drift remediation - auto-approve secondary approvers` both `active=true` |

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
              │ cloudflare tunnel #1 (in-cluster)     │  https://<random>.trycloudflare.com
              │ Deployment cloudflared-tfc-eda/       │  (TFC notif config nc-2Q8Lhk54ahNRVoRd)
              │   cloudflared → Service               │
              │   tfc-notification-drift:5004         │
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
              │ cloudflare tunnel #2 (in-cluster)     │  https://<random>.trycloudflare.com
              │ Deployment cloudflared-snow-eda/      │  (URL rotates only on cloudflared pod restart)
              │   cloudflared → Service               │                        │
              │   snow-cr-approval:5005               │                        │
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
account required. As of `tfo-apj-demos/terraform-openshift-platform-apps`
PR #6, **both `cloudflared` connectors run inside the cluster** as
one-replica Deployments managed by Terraform via
`modules/cloudflared-quick-tunnel`. No `oc port-forward`, no Mac
dependency, no laptop in the loop.

| # | Direction | Public URL | Tunnels to | Used by |
|---|---|---|---|---|
| 1 | TFC → EDA | `https://<random>.trycloudflare.com` (rotates only on cloudflared pod restart — see below) | k8s Service `tfc-notification-drift.aap.svc.cluster.local:5004` → activation 17 (HMAC validated) | TFC workspace notification config `nc-2Q8Lhk54ahNRVoRd` |
| 2 | SN → EDA | `https://<random>.trycloudflare.com` (rotates only on cloudflared pod restart) | k8s Service `snow-cr-approval.aap.svc.cluster.local:5005` → activation 18 (no auth yet — see § 11) | SN Outbound REST Message `AAP EDA - CR approval` |

The cloudflared connector Deployments live in dedicated namespaces
(`cloudflared-tfc-eda` and `cloudflared-snow-eda`). Each has a sibling
`NetworkPolicy` in the `aap` namespace
(`aap-eda-activation-from-cloudflared-only` for 5004,
`snow-eda-from-cloudflared-only` for 5005) restricting that port on
`app=eda` pods to ingress from only the matching tunnel namespace — no
in-cluster bypass to the webhook ports.

**Discover the current URL**:

```bash
oc -n cloudflared-tfc-eda  logs deploy/cloudflared | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1
oc -n cloudflared-snow-eda logs deploy/cloudflared | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1
```

**When a URL rotates** (only when the cloudflared pod itself
restarts — activation pod restarts no longer rotate it):

```bash
# 1. discover the new URL (commands above), set NEW=...
# 2. update the consuming side:

# TFC notification config #1 — recommended path is to re-run the
# combined HMAC+URL rotation script so the secret stays sync'd:
TUNNEL_URL=$NEW NEW_SECRET=... ./rotate-and-wire-tfc-notification.sh

# SN Outbound REST Message #2:
curl -sk -u "admin:pwKi%D6I9-Ja" -X PATCH \
  https://dev389292.service-now.com/api/now/table/sys_rest_message/20cbe2f8938583105e8930018bba103b \
  -H 'Content-Type: application/json' \
  -d "{\"rest_endpoint\": \"$NEW\"}"
```

Restart the cloudflared pod intentionally (e.g. after a CF image update) with:

```bash
oc -n cloudflared-snow-eda rollout restart deploy/cloudflared
oc -n cloudflared-snow-eda rollout status  deploy/cloudflared
```

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

### 7.1 Cloudflare tunnel URL rotation

Since both connectors moved into the cluster (see § 3.2), the only
remaining fragility is **the URL rotates every time the cloudflared
pod itself restarts** (image pull, node drain, manual rollout). The pod
restart is rare — the existing `cloudflared-tfc-eda` pod has gone 4+ days
between restarts in practice — but it isn't zero.

| Symptom | Diagnosis | Fix |
|---|---|---|
| TFC notification delivery failures; no `drift-create-snow-tickets` job in AAP | `curl <tfc-tunnel-url>` returns connection refused / DNS failure; `oc -n cloudflared-tfc-eda get pods` shows new pod | re-discover URL → `rotate-and-wire-tfc-notification.sh` with `TUNNEL_URL=$NEW` to update TFC notification config (+ rotate HMAC at the same time) |
| SN syslog shows `AAP EDA webhook fired … status=0` or `502`; no `tfc-trigger-apply` job | `curl <sn-tunnel-url>` fails; `oc -n cloudflared-snow-eda get pods` shows new pod | re-discover URL → PATCH SN Outbound REST Message endpoint `20cbe2f8938583105e8930018bba103b` |

The retired Mac-side troubleshooting (`oc port-forward` / `pkill cloudflared` /
restarting a local quick-tunnel) is **no longer applicable** — those moving
parts were retired with PR #6. If something on the SN→EDA path looks broken,
the failure is one of: cloudflared pod restarted (URL rotation, above),
activation 18 pod restarted (cluster DNS routes traffic to the new pod
automatically — no action needed), or the NetworkPolicy is denying ingress
(check `oc -n aap describe networkpolicy snow-eda-from-cloudflared-only`).

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

### 7.4 Activation restarts (no longer a tunnel problem — retired)

Historically, when activation 18 restarted the activation-job pod was
re-created with a new name, breaking the laptop-side `oc port-forward
pod/<name> 5005:5005`. With the cloudflared connector inside the cluster
talking to the k8s Service (`snow-cr-approval.aap.svc.cluster.local:5005`)
rather than a specific pod, cluster DNS routes traffic to the new pod
automatically. Nothing to do on activation restart. Kept here as a
historical pointer so older runbook screenshots make sense.

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

Quick tunnel URLs are regenerated on every `cloudflared` pod restart.
The connector now runs in-cluster (see § 3.2) so the laptop-dependency
half of this problem is gone, but the URL still rotates on pod restart
and needs propagating to TFC + SN. Production-grade fix is a named
Cloudflare tunnel (see § 11) — pin the hostname so even cloudflared pod
restarts don't break the loop.

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

Ordered roughly by impact-per-effort. The first three are the immediate
follow-ups that came out of the in-cluster cloudflared move.

| # | Topic | Status | Notes |
|---|---|---|---|
| 1 | **Bearer-token auth on activation 18** + `rotate-and-wire-sn-notification.sh` | Open | activation 18 currently accepts any POST. Mirror the activation-17 HMAC pattern with a simpler bearer token: SN `Notify EDA on CR approval` business rule adds `r.setRequestHeader('Authorization','Bearer ${sn_eda_token}')` before `r.execute()`; activation 18's rulebook validates with the webhook source's `password:` field or a rule-level `condition: event.meta.headers.Authorization == "Bearer ..."`. Rotation script mirrors the existing `rotate-and-wire-tfc-notification.sh` shape — generate secret → disable activation → PATCH extra_var → enable → PATCH the SN BR script with the new value. Closes the open-webhook gap that the cloudflared cluster move alone doesn't fix. |
| 2 | **Named Cloudflare tunnel (stable URL)** | Open | Quick-tunnel URLs still rotate on cloudflared pod restart (§ 7.1). A named tunnel pins the public hostname forever. Costs: $0 if you bring an existing CF-managed domain, ~$10/yr if you register one via CF Registrar (at-cost, no markup). Implementation in `terraform-openshift-platform-apps`: extend `modules/cloudflared-quick-tunnel` (or fork to `modules/cloudflared-named-tunnel`) to provision `cloudflare_zero_trust_tunnel_cloudflared` + `_config` + `dns_record`, mount the tunnel run-token via Secret, swap `--url` for `--token`. Optional bonus: layer Cloudflare Access in front for zero-trust authn (replaces the bearer token above). |
| 3 | **Auto-propagate cloudflared URL changes** | Open | Sidecar in each cloudflared Deployment that tails logs, extracts the new `*.trycloudflare.com` URL, and PATCHes the consuming side (TFC notification config / SN Outbound REST Message) automatically. ~3 hr engineering. Only worth doing if the named-tunnel migration (#2) isn't on the cards. |
| 4 | OpenShift Route + public DNS instead of CF | Probably-not | Would only work if `apps.openshift-01.hashicorp.local` is internet-reachable from TFC/SN, which it isn't on this cluster (`.local`). Skip. |
| 5 | `hashicorp.terraform.run` adoption | Blocked on upstream `run_message` alias bug | File issue at `github.com/hashicorp/terraform-ansible-collection`; flip role back to module the moment it's fixed |
| 6 | Approval gate | Single human click after auto-CAB-resolve | Replace with custom Change Model + single Flow Designer approval step if the auto-resolve hack feels too clever for prod |
| 7 | Multi-workspace | Works as-is | `correlation_id = workspace_id` makes the SN→TFC step workspace-agnostic — pointing the TFC notification at the same EDA tunnel from a different workspace just works |
| 8 | Run failures | Job fails loudly | `tfc-trigger-apply` exits non-zero on apply failure → visible in AAP. Consider piping that back to SN to re-open the CR with the failure context |
| 9 | `before_destroy` / `after_destroy` actions | Not in Terraform 1.14 yet | When they land, hook a `cmdb-close-change` JT into `after_destroy` to close out the CR automatically once the apply succeeds |
