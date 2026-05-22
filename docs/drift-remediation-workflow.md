# Closed-loop drift remediation with HCP Terraform, AAP/EDA & ServiceNow

End-to-end technical reference for the workflow that detects out-of-band
changes to vSphere VMs managed by HCP Terraform, opens a ServiceNow
incident + change request for CAB approval, and — once approved —
fires the remediation `terraform apply` automatically through
Event-Driven Ansible (EDA).

## 1. What it does

Banks running RHEL workloads on vSphere need to:

1. **Detect** when someone bypasses Terraform and edits a VM directly
   (vCenter console, vMotion, someone twiddling CPUs in a hurry).
2. **Open** a ticket for the change so audit/CAB has a record.
3. **Authorise** the remediation via the normal CAB approval flow.
4. **Apply** the declared state back over the drift, automatically,
   right after the human approval lands.

The flow shown below ties HCP Terraform's drift detection to AAP/EDA
and back to HCP Terraform, with ServiceNow as the approval gate in
the middle.

## 2. Architecture

```
                                                            ╔═══════════════════════════╗
                                                            ║   HCP Terraform Cloud     ║
                                                            ║                           ║
                                                            ║  workspace                ║
                                                            ║  better-together-vm-      ║
                                                            ║  lifecycle-dev            ║
                                                            ║  (auto-apply ON)          ║
                                                            ╚═════════╤═════════════════╝
                                                                      │
                              ┌────[1] drift assessment ──────────────┘
                              │       webhook (HMAC)
                              ▼
              ┌───────────────────────────────────────┐
              │ cloudflared tunnel #1 (long-running)  │  https://depot-molecules-award-submit.trycloudflare.com
              │ → AAP EDA event stream "tfe notifs"   │
              └───────────────┬───────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────────────┐
              │ EDA activation #17                    │
              │  tfc-notification-drift               │
              │  rulebook  tfc-notification-rules     │
              │  rule "Drift Detected" →              │
              │                                       │
              └───────────────┬───────────────────────┘
                              │ run_job_template
                              ▼
              ┌───────────────────────────────────────┐                ┌───────────────┐
              │ AAP JT 90  drift-create-snow-tickets  │  ─ Vault ───>  │ HashiCorp     │
              │  role:  snow_drift_tickets            │  vault_kv2_get │ Vault         │
              │  POSTs Incident + Change Request      │                │  KV v2 mount  │
              └───────────────┬───────────────────────┘                │   /secrets    │
                              │ REST API                                └───────┬───────┘
                              ▼                                                │
              ╔═══════════════════════════════════════╗                        │
              ║ ServiceNow dev389292                  ║                        │
              ║                                       ║                        │
              ║  Incident INC0010xxx                  ║                        │
              ║  Change Request CHG0030xxx (Normal)   ║                        │
              ║   ├─ correlation_id     = ws-…        ║                        │
              ║   ├─ correlation_display = ws name   ║                         │
              ║   └─ approval state: → not_requested  ║                        │
              ║                                       ║                        │
              ║  Business Rules (auto-installed):     ║                        │
              ║   [a] AAP drift auto-approve secondary║                        │
              ║       CAB-group approvers             ║                        │
              ║   [b] Notify EDA on CR approval       ║                        │
              ║                                       ║                        │
              ║   [3] Human approves CR in UI         ║                        │
              ║       (single click — Change Mgr)     ║                        │
              ║       approval flips to "approved"    ║                        │
              ║   [b] business rule fires Outbound    ║                        │
              ║       REST Message "AAP EDA – CR      ║                        │
              ║       approval"                       ║                        │
              ╚════════════════╤══════════════════════╝                        │
                               │  POST {cr_number,                             │
                               │        correlation_id (ws-…),                 │
                               │        approver, …}                           │
                               ▼                                               │
              ┌───────────────────────────────────────┐                        │
              │ cloudflared tunnel #2 (port 5005)     │                        │
              │ → activation #18 webhook on 5005      │                        │
              └───────────────┬───────────────────────┘                        │
                              │                                                │
                              ▼                                                │
              ┌───────────────────────────────────────┐                        │
              │ EDA activation #18                    │                        │
              │  snow-cr-approval                     │                        │
              │  rulebook  snow-cr-approval-rules     │                        │
              │  rule "CR Approved → trigger apply" → │                        │
              └───────────────┬───────────────────────┘                        │
                              │ run_job_template                               │
                              ▼                                                │
              ┌───────────────────────────────────────┐                        │
              │ AAP JT 91  tfc-trigger-apply          │ ─ Vault ────────────── │
              │  role:  tfc_trigger_apply             │ vault_kv2_get          │
              │  [a] POST /runs        → create       │                        │
              │  [b] POST /comments    → audit trail  │                        │
              │  [c] poll plan         → wait         │                        │
              │  [d] optionally confirm → apply       │                        │
              │  [e] poll apply        → terminal     │                        │
              └───────────────┬───────────────────────┘                        │
                              │ HCP TF REST API                                │
                              │                                                │
                              ▼                                                │
                       ╚════════════════╗                                      │
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
| Notification config | `EDA drift notification` (id `nc-2Q8Lhk54ahNRVoRd`) <br>triggers: `assessment:drifted` <br>destination URL: `https://depot-molecules-award-submit.trycloudflare.com` |
| Health assessments | Required (this is what produces the `assessment:drifted` event) |

### 3.2 Cloudflare quick tunnels (two of them)

Both are `trycloudflare.com` quick tunnels (no Cloudflare account needed)
serving as a public ingress in front of internal AAP EDA event streams.

| Direction | Public URL | Tunnels to | Used by |
|-----------|------------|------------|---------|
| TFC → EDA | `https://depot-molecules-award-submit.trycloudflare.com` | EDA event stream `tfe notifications` (HMAC, port 5004) | Workspace notification config |
| SN → EDA | `https://guns-plains-main-grocery.trycloudflare.com` | activation 18 webhook source, port 5005 | SN Outbound REST Message |

**Both URLs are ephemeral.** They survive only while the `cloudflared`
processes are running. If a process dies, the URL changes and the
corresponding notification config / Outbound REST endpoint must be
updated.

### 3.3 AAP / EDA — IDs

| Object | Type | ID | Notes |
|--------|------|----|----|
| `ansible-rhel-post-deploy` | AAP project | 57 | Source: `github.com/hashi-demo-lab/ansible-rhel-post-deploy` |
| `terraform_eda_run_task` | EDA project | 1 | Source: `github.com/tfo-apj-demos/terraform-eda-example` |
| Execution Environment | AAP EE | 4 | `quay.io/aaroneautomate/hashi-demo-ee:latest` — has `community.hashi_vault`, `community.vmware` |
| GCVE Decision Environment | EDA DE | 3 | Used by EDA activations |
| `HashiCorp Vault Access` | AAP cred | 19 | AppRole — injects `role_id`/`secret_id` env vars |
| `AAP` | EDA cred | 7 | "Red Hat AAP" credential — lets EDA call the AAP controller |
| `drift-create-snow-tickets` | AAP JT | 90 | inventory 363 baked in, Vault cred 19 attached |
| `tfc-trigger-apply` | AAP JT | 91 | inventory 363 baked in, Vault cred 19 attached |
| `tfc-notification-rules.yaml` | EDA rulebook | 4 | Drift Detected rule fires JT 90 |
| `snow-cr-approval-rules.yaml` | EDA rulebook | 11 | CR Approved rule fires JT 91 |
| `tfc-notification-drift` | EDA activation | 17 | Uses rulebook 4, webhook on port 5004, HMAC validated |
| `snow-cr-approval` | EDA activation | 18 | Uses rulebook 11, webhook on port 5005 |

### 3.4 ServiceNow dev389292

| Object | Type | sys_id | Notes |
|--------|------|--------|----|
| `AAP EDA - CR approval` | Outbound REST Message | `20cbe2f8938583105e8930018bba103b` | Endpoint = SN→EDA tunnel URL |
| POST function | sys_rest_message_fn | `46db6e3c938583105e8930018bba103f` | Body template with `${cr_number}`, `${correlation_id}`, etc. |
| Content-Type header | sys_rest_message_fn_headers | `12db6e3c938583105e8930018bba1048` | `application/json` |
| `Notify EDA on CR approval` | Business Rule (sys_script) | `611c66f8938583105e8930018bba101f` | Fires `after` an `update` on `change_request` when `approvalCHANGESTOapproved` |
| `AAP drift remediation - auto-approve secondary approvers` | Business Rule | `e15213f4938983105e8930018bba101b` | Auto-approves any CAB-group approval on drift CRs (correlation_id starts `ws-`) |
| Normal change model | chg_model | `007c4001c343101035ae3f52c1d3aeb2` | OOTB. Used as `chg_model` on drift CRs. |

### 3.5 HashiCorp Vault

Two KV v2 paths the playbooks read at runtime via the AppRole the
`HashiCorp Vault Access` AAP cred provides:

| Path | Shape | Read by | Used for |
|------|-------|---------|---------|
| `secrets/servicenow/dev` | `{ username, password }` | `snow_drift_tickets` role | Basic-auth to SN REST API |
| `secrets/tfc/api` | `{ token }` | `tfc_trigger_apply` role | Bearer token for HCP TF API |

The `ansible` AppRole already has `read_kv` policy (`secrets/data/*`)
attached, so no policy changes were required — only populating the
two paths.

Both paths are managed by Terraform in `terraform-vsphere-vault-config`
(see `secrets_kv.tf`) with `ignore_changes = [data_json]` so manual
edits to the secret bodies via the Vault UI aren't reverted on the
next workspace apply.

### 3.6 Ansible playbooks & roles

In `hashi-demo-lab/ansible-rhel-post-deploy`:

```
playbooks/
├── drift-create-snow-tickets.yml      ← fires from EDA on drift event
└── tfc-trigger-apply.yml              ← fires from EDA on CR approved
roles/
├── snow_drift_tickets/                ← opens incident + CR in SN
└── tfc_trigger_apply/                 ← creates TFC run, polls, comments
```

In `tfo-apj-demos/terraform-eda-example`:

```
rulebooks/
├── tfc-notification-rules.yaml        ← used by activation 17
└── snow-cr-approval-rules.yaml        ← used by activation 18
```

## 4. End-to-end flow walkthrough

### Step 1 — Drift detection

HCP Terraform runs a health assessment on the workspace (configurable
interval). When the assessment diff > 0 resources, TFC sends a
notification with `message == "Drift Detected"` to the configured
URL (cloudflare tunnel #1).

**Payload sample (only the fields we consume):**
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

### Step 2 — EDA receives, fires drift-create-snow-tickets JT

`tfc-notification-rules.yaml` listens on port 5004 with HMAC validation
(secret `tf_hmac_notification` is on activation 17 as an extra_var).

When the `Drift Detected` rule matches, it calls
`run_job_template name: drift-create-snow-tickets` and passes the
workspace_id/name/etc. through `job_args.extra_vars`.

### Step 3 — drift-create-snow-tickets opens incident + CR

The playbook (`hosts: localhost`, `connection: local`) does, in order:

1. `community.hashi_vault.vault_kv2_get` on `secrets/servicenow/dev`
   to fetch SN admin credentials.
2. `POST /api/now/table/incident` with the workspace context in the
   description and `correlation_id = workspace_id`.
3. `POST /api/now/table/change_request` similarly. `type: normal`
   (so it goes through CAB approval), `correlation_id = workspace_id`,
   `correlation_display = "HCP Terraform workspace <name>"`.

The job logs the incident + CR numbers + SN URLs in its output for
demo visibility.

### Step 4 — CAB approval in ServiceNow

The CR appears in SN at `state=New`, `approval=Not Yet Requested`.
When the operator clicks **Request Approval** (or moves State →
Authorize), the OOTB Normal change model creates ~11 approval records
in `sysapproval_approver`. Most resolve to `not_required` based on
conditions; two would normally need a human approval:

- **Change Manager** (`david.loo` in OOTB dev389292) — single user
- **CAB Approval group** — one randomly-selected member of the group

The `AAP drift remediation - auto-approve secondary approvers`
business rule fires on each `sysapproval_approver` insert/update,
checks if the approver is in the **CAB Approval** group AND if the
CR's `correlation_id` starts with `ws-` (our drift remediation
marker), and if so auto-approves that record with a comment trail.

Net result: the operator sees **one** pending approval (Change
Manager) in *My Approvals*. They click Approve. The CR's `approval`
field flips to `approved`.

### Step 5 — SN business rule fires Outbound REST Message

The `Notify EDA on CR approval` business rule (table:
`change_request`, when: `after update`, filter:
`approvalCHANGESTOapproved`) builds the payload via
`sn_ws.RESTMessageV2('AAP EDA - CR approval', 'post')`:

```javascript
r.setStringParameterNoEscape('cr_number',      current.number.toString());
r.setStringParameterNoEscape('cr_sys_id',      current.sys_id.toString());
r.setStringParameterNoEscape('correlation_id', current.correlation_id.toString());
r.setStringParameterNoEscape('workspace_name', current.correlation_display.toString());
r.setStringParameterNoEscape('approver',       gs.getUserName());
```

The `${...}` placeholders in the Outbound REST Message body template
get substituted, and SN POSTs:

```json
{
  "cr_number"       : "CHG0030xxx",
  "cr_sys_id"       : "...",
  "correlation_id"  : "ws-JxUw2w1CoWwCRwZe",
  "workspace_name"  : "HCP Terraform workspace better-together-vm-lifecycle-dev",
  "approver"        : "admin",
  "approval_state"  : "approved"
}
```

to the cloudflare tunnel #2 URL.

### Step 6 — EDA receives, fires tfc-trigger-apply JT

`snow-cr-approval-rules.yaml` listens on port 5005, no auth (dev only
— in prod use HMAC or basic auth). Rule condition:

```yaml
condition: event.payload.approval_state == "approved" and event.payload.correlation_id is defined
```

On match, the rule fires `run_job_template name: tfc-trigger-apply`
with `tfc_workspace_id`, `tfc_run_message`, `tfc_approver`,
`tfc_cr_number` lifted from `event.payload`.

### Step 7 — tfc-trigger-apply queues the TFC run

The playbook:

1. Reads `secrets/tfc/api` from Vault for the TFC API token.
2. `POST /api/v2/runs` to create a new run on the workspace identified
   by `tfc_workspace_id` (= the CR's `correlation_id`).
3. `POST /api/v2/runs/{id}/comments` to write the audit comment
   showing CR number + approver — this surfaces who authorised it
   on the run's Comments tab in the TFC UI.
4. Polls `GET /runs/{id}` until status leaves the planning phase
   (i.e., not in `[pending, fetching, fetching_completed, queuing,
   managed_queued, plan_queued, planning, cost_estimating,
   policy_checking]`).
5. If the run is at a confirmable state (`planned`, `cost_estimated`,
   `policy_checked`) AND auto-apply is on the workspace (which
   produces a 409 from the confirm endpoint, handled), posts
   `/runs/{id}/actions/apply` with a comment naming the approver.
6. Polls until the run reaches a terminal status (`applied`,
   `planned_and_finished`, `errored`, `canceled`, `discarded`,
   `policy_hard_failed`, `policy_soft_failed`).
7. Fails the Ansible job iff the final status is not `applied` or
   `planned_and_finished` — so a failed remediation is visible in
   AAP's job audit, not silently swallowed.

### Step 8 — TFC applies, drift reconciled

The workspace has `auto-apply = true`, so after the plan succeeds
the run auto-confirms and applies. The VM module re-applies the
declared CPU/memory/tags over whatever drifted, restoring the
declared state. End of loop.

## 5. Demo dry-run

Pre-flight (one-time, already done):

- Vault paths `secrets/servicenow/dev` and `secrets/tfc/api`
  populated with real credentials.
- Both cloudflared quick tunnels running.
- AAP project 57 + EDA project 1 synced; activations 17 + 18 running.

Demo path:

1. **Trigger drift**: change a VM's `num_cpus` directly in vCenter
   (or any out-of-band edit Terraform manages). Wait for the next
   workspace health assessment (interval is workspace-configurable).
2. TFC sends `Drift Detected` to cloudflare tunnel #1.
3. **AAP — drift-create-snow-tickets job** appears in
   *Automation Execution → Jobs*. Tail the output to see incident
   + CR numbers + their SN URLs printed.
4. **ServiceNow — open the CR** at the URL from the job output.
   `Reconcile VM compute drift via Terraform — <workspace>`.
5. Click **Request Approval** → SN creates approval tasks. The
   auto-approve business rule resolves the CAB ones; you see **one**
   pending approval (Change Manager).
6. Click **Approve** on that single approval. CR's `approval` field
   flips to `approved`.
7. **AAP — tfc-trigger-apply job** appears almost immediately.
   The job log shows the run id, then the audit comment posted,
   then plan polling, then apply polling, then a final status line
   reporting `applied` or the failure mode.
8. **HCP TF UI** — the workspace shows a new run titled
   *"Drift remediation — ServiceNow CHGxxxxxxx approved by admin"*
   with the audit comment visible on the run's Comments tab. The
   apply reconciles the drift.

## 6. Operational notes

### 6.1 Tunnel fragility

The two `trycloudflare.com` quick tunnels are ephemeral. If either
`cloudflared` process or the `oc port-forward` it sits behind dies,
the corresponding webhook hits return HTTP 502 and the chain is
broken at that step.

| If broken | What you see | Fix |
|-----------|--------------|-----|
| Tunnel #1 (TFC → EDA) | TFC notification config shows failed deliveries; no `drift-create-snow-tickets` job in AAP | restart `cloudflared` + port-forward for activation 17 (port 5004) and update the TFC notification config URL |
| Tunnel #2 (SN → EDA) | SN `syslog` shows `AAP EDA webhook fired … status=502`; no `tfc-trigger-apply` job | restart `cloudflared` + port-forward for activation 18 (port 5005) and update the Outbound REST Message endpoint |

For a stable demo, replace quick tunnels with named tunnels on a
Cloudflare account, or expose the EDA event-stream URLs via an
OpenShift Route in front of `aap-eda-event-stream` and skip
cloudflared entirely.

### 6.2 Activation restarts change the pod name

`oc port-forward` binds to a specific pod. When the activation
restarts (e.g., after a rulebook update), the activation-job pod is
re-created with a new name and the existing port-forward dies. Find
the current pod and re-run port-forward:

```bash
POD=$(oc get pods -n aap -o name | grep activation-job-18)
oc -n aap port-forward $POD 5005:5005 &
```

### 6.3 Approval gate is a real human decision

The auto-approval business rule only resolves the CAB group approvals
on drift CRs. The Change Manager approval — currently configured to
fire to `david.loo` on dev389292 — remains a manual click. If you
want the demo to require approval by a specific bank role (e.g.,
"Platform Engineering Manager"), update the Change Manager rule on
the chg_model `007c4001c343101035ae3f52c1d3aeb2` accordingly.

### 6.4 Filter scoping

Both the auto-approval business rule and the EDA-notify business rule
are filtered:

- Auto-approve rule: `state=requested` AND in-script check
  `cr.correlation_id startswith 'ws-'` AND approver is in `CAB Approval`.
- Outbound REST rule: `approvalCHANGESTOapproved` on `change_request`.

The first rule's correlation_id filter is what stops it from
auto-approving any other change request on the dev instance — only
ones our pipeline created carry a `ws-…` correlation_id.

### 6.5 No secrets in JT extra_vars

Neither the SN admin password nor the HCP TF token live in
JT-level extra_vars. Both come from Vault via the existing AppRole
(`secrets/data/*` read access via the `read_kv` policy). To rotate,
update the values in Vault — no AAP changes needed.

### 6.6 Audit trail surfaces in three places

| System | Audit artefact |
|--------|----------------|
| ServiceNow | Incident + CR with linked `correlation_id`, plus auto-approval comments on each pre-resolved approval task |
| HCP Terraform | The run's `message` field shows "Drift remediation — ServiceNow CHG… approved by admin"; the Comments tab carries a structured comment with CR + approver + JT + activation |
| AAP | Job output from `drift-create-snow-tickets` shows the incident + CR numbers; job output from `tfc-trigger-apply` shows the run id + run states + final status |

## 7. Configuration reference (quick lookup)

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

Both JTs use AAP inventory id **363** (`Better Together Demo - …`) so
the launch endpoint accepts the request. The playbooks themselves
target `hosts: localhost` and don't read the inventory's host list.

## 8. Known limitations / next steps

| Topic | Status | Notes |
|-------|--------|-------|
| Public ingress | Demo-grade (cloudflared quick tunnels) | Replace with named Cloudflare tunnels or OpenShift Routes for production |
| Webhook auth | None on activation 18 | Add basic-auth or HMAC on the `ansible.eda.webhook` source + corresponding profile/headers on the SN Outbound REST Message |
| Approval gate | Single human click after auto-CAB-resolve | Switch to a custom Change Model with a single Flow Designer approval step if the auto-resolve hack is too clever for prod |
| Multi-workspace | Works as-is | `correlation_id = workspace_id` makes the SN→TFC step workspace-agnostic — pointing the TFC notification at the same EDA tunnel from a different workspace just works |
| Run failures | Job fails loudly | `tfc-trigger-apply` exits non-zero on apply failure → visible in AAP. Consider piping that back to SN to reopen the CR with the failure context |
| Multi-CR concurrency | Untested | If two drifts trigger near-simultaneously two distinct CRs are created; both flow independently. Sensible behaviour but not load-tested |
| `before_destroy` / `after_destroy` actions | Not in Terraform 1.14 | When they land, hook a `cmdb-close-change` JT into `after_destroy` to close out the CR automatically once the apply succeeds |
