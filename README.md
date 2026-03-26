# ansible-rhel-post-deploy

Ansible playbooks and roles for post-deployment provisioning of RHEL systems. Used as part of the VM provisioning pipeline with HCP Terraform and Ansible Automation Platform (AAP).

## Playbooks

| Playbook | AAP Job Template | Purpose |
|----------|-----------------|---------|
| `playbooks/rhel-register.yml` | `rhel-register` | Register RHEL with Red Hat Subscription Manager |
| `playbooks/install-nginx.yml` | `rhel-install-nginx` | Install and configure Nginx web server |

## Roles

### `rhel_register`
Registers RHEL systems with RHSM. Supports two authentication methods:
- **Credentials** (default): Uses `RHN_USERNAME` and `RHN_PASSWORD` environment variables
- **Activation key**: Uses `rhsm_activation_key` and `rhsm_org_id` variables

### `install_nginx`
Installs Nginx, creates SSL directory structure, configures firewall, and starts the service. SSL certificate deployment is handled separately by [vault-ansible-clm](https://github.com/hashi-demo-lab/vault-ansible-clm).

## Provisioning Flow
1. HCP Terraform provisions VMs
2. `rhel-register` — registers with RHSM (enables repos)
3. `rhel-install-vault-agent` — installs HashiCorp Vault Agent (separate project)
4. `rhel-install-nginx` — installs Nginx
5. `clm_issue_deploy` — issues and deploys TLS certificates from Vault PKI (separate project)

## Requirements
- RHEL 9 target hosts
- Ansible collections: `ansible.posix >= 1.5.0`, `community.general >= 6.0.0`
