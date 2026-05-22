# Closed-loop drift remediation — TFC → EDA → ServiceNow → EDA → TFC

End-to-end flow tying HCP Terraform drift detection to ServiceNow CAB
approval and back, with Event-Driven Ansible as the message bus.

```
[HCP TF drift assessment]
        ↓ POST to cloudflared URL
[EDA event stream "tfe notifications" (HMAC)]
        ↓ rule: Drift Detected
[AAP JT: drift-create-snow-tickets]   ← id 90
        ↓ POST /api/now/table/incident  + /api/now/table/change_request
[ServiceNow] (CR awaits CAB approval, correlation_id = workspace_id)
        ↓ CAB clicks Approve in SN UI
[SN business rule fires Outbound REST Message]
        ↓ POST to cloudflared URL
[EDA event stream "snow-cr-approval" (port 5005 webhook)]
        ↓ rule: CR Approved -> trigger HCP TF apply
[AAP JT: tfc-trigger-apply]            ← id 91
        ↓ POST /api/v2/runs + /actions/apply
[HCP TF] (queues + applies — drift remediated)
```

## What's already built (AAP side)

| Component | ID | Notes |
|-----------|----|----|
| Playbook `drift-create-snow-tickets.yml` | — | Reads SN creds from Vault path `secrets/servicenow/dev`, opens incident + CR with workspace_id in `correlation_id` |
| Playbook `tfc-trigger-apply.yml` | — | Reads TFC token from Vault path `secrets/tfc/api`, creates a run, polls plan + apply |
| AAP JT `drift-create-snow-tickets` | 90 | Vault cred 19 attached |
| AAP JT `tfc-trigger-apply` | 91 | Vault cred 19 attached |
| EDA rulebook `tfc-notification-rules.yaml` | 4 | "Drift Detected" rule now fires JT 90 (was drift-remediate) |
| EDA rulebook `snow-cr-approval-rules.yaml` | 11 | New — webhook on port 5005, fires JT 91 on `approval_state == approved` |
| EDA activation `tfc-notification-drift` | 17 | Restarted on the updated rulebook |
| EDA activation `snow-cr-approval` | 18 | New — runs on rulebook 11, AAP cred 7 attached |

## What you still need to set up

### 1 — Two Vault KV v2 secrets

The same AppRole the other playbooks already use (`secrets/data/*`
covered by the `read_kv` policy) needs these two paths populated:

```bash
# ServiceNow dev — basic auth for the REST API
vault kv put secrets/servicenow/dev \
  username=admin \
  password='pwKi%D6I9-Ja'

# HCP Terraform user/team token with workspace:write + run:create
vault kv put secrets/tfc/api \
  token='<your TFC token>'
```

After populating, the AppRole (`ansible`) has read on both. The
playbooks fetch them via `community.hashi_vault.vault_kv2_get`
at runtime — nothing on disk or in JT extra_vars.

### 2 — A second cloudflared tunnel for the SN→EDA path

The existing trycloudflare tunnel
(`https://depot-molecules-award-submit.trycloudflare.com`) maps to
port 5004 (activation 17's TFC webhook). The new SN→EDA listener is
on port 5005. Easiest: run a second quick tunnel:

```bash
cloudflared tunnel --url http://<eda-host>:5005
```

You'll get back another `https://<random>.trycloudflare.com` URL.
Copy that — it goes into the SN Outbound REST Message below.

### 3 — ServiceNow Outbound REST Message

In ServiceNow → **System Web Services → Outbound → REST Message**:

- **Name**: `AAP EDA — CR approval`
- **Endpoint**: `https://<random>.trycloudflare.com` (the new tunnel URL from step 2)
- **HTTP Method**: POST
- **Authentication**: None (the dev instance can call out freely; for prod, wire HMAC or basic auth on the EDA side and a matching auth profile here)
- **HTTP Headers**:
  - `Content-Type: application/json`
- **HTTP Body** (substitution variables driven by the business rule below):
  ```json
  {
    "cr_number": "${cr_number}",
    "cr_sys_id": "${cr_sys_id}",
    "correlation_id": "${correlation_id}",
    "workspace_name": "${workspace_name}",
    "approver": "${approver}",
    "approval_state": "approved"
  }
  ```

### 4 — ServiceNow Business Rule

In **System Definition → Business Rules**, create a new rule:

- **Name**: `Notify EDA on CR approval`
- **Table**: `Change Request [change_request]`
- **When**: `after`
- **Insert**: no
- **Update**: yes
- **Filter Conditions**: `Approval` changes to `Approved`
- **Advanced** → script:

```javascript
(function executeRule(current, previous) {
  try {
    var r = new sn_ws.RESTMessageV2('AAP EDA — CR approval', 'post');
    r.setStringParameterNoEscape('cr_number',      current.number.toString());
    r.setStringParameterNoEscape('cr_sys_id',      current.sys_id.toString());
    r.setStringParameterNoEscape('correlation_id', current.correlation_id.toString());
    r.setStringParameterNoEscape('workspace_name', current.correlation_display.toString());
    r.setStringParameterNoEscape('approver',       gs.getUserName());
    var response = r.execute();
    gs.info('AAP EDA webhook fired for ' + current.number +
            ' status=' + response.getStatusCode());
  } catch (e) {
    gs.error('Failed to notify AAP EDA: ' + e.message);
  }
})(current, previous);
```

That's the round-trip: SN sends the workspace_id back to AAP via
`correlation_id`, EDA reads it, and `tfc-trigger-apply` fires a
remediation run against exactly that workspace.

## Demo dry-run

1. Trigger drift (e.g. change a VM's CPU count in vCenter against a
   workspace with health assessments enabled, then wait for the next
   assessment).
2. TFC POSTs to the existing cloudflared URL → activation 17 → JT 90
   creates an incident + CR in `dev389292`.
3. Open the CR in SN UI. The short description is "Reconcile VM
   compute drift via Terraform — &lt;workspace&gt;".
4. Click Approve. SN business rule POSTs to the second cloudflared URL.
5. Activation 18 fires JT 91 → calls HCP TF API → new run queued.
6. Workspace has `auto-apply = true` (in the better-together demo
   workspace at least), so the run applies automatically.
7. Drift remediated. JT 91 polls until status `applied` and returns
   green.

## Gotchas / known follow-ups

- **trycloudflare URLs are ephemeral** — they change on every restart.
  If you'll demo more than once, either keep the same `cloudflared`
  process running or switch to a named cloudflare tunnel (free with a
  cloudflare account).
- **Activation 18 is unauthenticated** — anyone who knows the URL can
  POST to it. Fine for a dev SN dev tunnel demo, not for prod. Switch
  to HMAC or basic auth on the EDA webhook source and add a matching
  auth profile on the SN side.
- **Workspace IDs aren't human-readable** — the CR carries the workspace
  ID (e.g. `ws-JxUw2w1CoWwCRwZe`) in `correlation_id` and the friendly
  name in `correlation_display`. CAB approvers will see the friendly
  name in the CR description.
