# ansible-rhel-post-deploy

Ansible playbooks and roles for VM lifecycle automation against RHEL on
vSphere. Built to plug into [better-together-vm-lifecycle][btvl] via
Ansible Automation Platform (AAP) job templates that HCP Terraform
launches as **actions** on the four lifecycle events Terraform 1.14
exposes: `before_create`, `after_create`, `before_update`,
`after_update`.

The naming convention encodes the intent:

| Prefix | Where it runs | When it fires | Typical use |
|--------|---------------|---------------|-------------|
| `pre-*` | AAP control node (`connection: local`) | `before_create` / `before_update` | Change tickets, IPAM, snapshots, LB drain |
| `rhel-*` | The target VM (SSH) | `after_create` / `after_update` | Hardening, agents, AD join, validation |
| `post-*` | AAP control node (`connection: local`) | `after_update` | LB re-enable, compliance rescan |

## Playbooks → AAP Job Templates

### before_create — runs **before** the VM exists

| Playbook | AAP Job Template | Purpose |
|----------|------------------|---------|
| `playbooks/pre-cmdb-change-open.yml` | `pre-cmdb-change-open` | Open a ServiceNow change record (CAB-ready fields, auto-linked to the TFC run) |
| `playbooks/pre-ipam-reserve.yml` | `pre-ipam-reserve` | Reserve next-available IP + DNS record in Infoblox |

### after_create — runs once the VM is up

| Playbook | AAP Job Template | Purpose |
|----------|------------------|---------|
| `playbooks/rhel-register.yml` | `rhel-register` | Register with Red Hat Subscription Manager |
| `playbooks/rhel-cis-hardening.yml` | `rhel-cis-hardening` | CIS Level 1 / DISA STIG-aligned baseline (kernel, password, SSH, auditd) |
| `playbooks/rhel-splunk-uf-install.yml` | `rhel-splunk-uf-install` | Install + configure Splunk Universal Forwarder to bank SIEM indexers |
| `playbooks/rhel-crowdstrike-install.yml` | `rhel-crowdstrike-install` | Install CrowdStrike Falcon EDR sensor, set CID + grouping tags |
| `playbooks/rhel-qualys-install.yml` | `rhel-qualys-install` | Install + activate Qualys Cloud Agent |
| `playbooks/rhel-ad-domain-join.yml` | `rhel-ad-domain-join` | Join Active Directory via realmd/SSSD; AD-group sudoers |
| `playbooks/rhel-chrony-timesync.yml` | `rhel-chrony-timesync` | Configure chrony against bank stratum-1 NTP (trade-grade time) |
| `playbooks/install-nginx.yml` | `rhel-install-nginx` | Install + configure Nginx web server |

### before_update — runs **before** Terraform mutates the VM

| Playbook | AAP Job Template | Purpose |
|----------|------------------|---------|
| `playbooks/pre-vsphere-snapshot.yml` | `pre-vsphere-snapshot` | Take a pre-change vSphere snapshot via REST (TTL-tagged) |
| `playbooks/pre-lb-pool-drain.yml` | `pre-lb-pool-drain` | Drain VM from its F5 BIG-IP pool with a grace window |

### after_update — runs after the change applies

| Playbook | AAP Job Template | Purpose |
|----------|------------------|---------|
| `playbooks/rhel-post-change-validate.yml` | `rhel-post-change-validate` | TCP / systemd / HTTP / clock-skew validation; fails the play (and the action) if any check regresses |
| `playbooks/post-lb-pool-reenable.yml` | `post-lb-pool-reenable` | Re-add VM to F5 pool, wait for monitor:up, trigger Qualys rescan |

## Secrets

All credentials are read at runtime from HashiCorp Vault via the
`community.hashi_vault.vault_kv2_get` module using AppRole auth. There
are no static credentials in this repo or in AAP-stored extra vars. The
Vault paths each role expects are documented in its `defaults/main.yml`.

## Demo-Safe Defaults

Roles that talk to vendor SaaS (ServiceNow, Infoblox, F5, Qualys) ship
with a `*_simulate: true` flag in `defaults/main.yml`. Simulated mode
prints the request payload to the AAP job log instead of making the
real API call, so the full lifecycle can be exercised in lab without
real backend systems. Flip to `false` in prod.

## Variables Injected by Terraform

The HCP Terraform workspace populates each `aap_host` with the
following variables (used across multiple roles):

- `site` — datacenter (sydney, melbourne, …)
- `env` — environment (dev, prod, …)
- `security_profile` — web-server, app-server, db-server (drives LB pool lookup)
- `os_type`, `linux_distribution`
- `storage_profile`, `backup_policy`, `tier`
- `ansible_host` — the IP returned by the VM module

## Requirements

- RHEL 9 target hosts
- AAP execution environment with the collections in `requirements.yml`
  (`ansible.posix`, `community.general`, `community.hashi_vault`,
  `community.vmware`)
- HashiCorp Vault reachable from the AAP control node

[btvl]: https://github.com/tfo-apj-demos/better-together-vm-lifecycle
