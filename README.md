# ansible-install-nginx

Ansible playbook for installing and configuring Nginx on RHEL systems.

This is a provisioning dependency for the [vault-ansible-clm](https://github.com/hashi-demo-lab/vault-ansible-clm) certificate lifecycle management project.

## Usage

### In AAP (Ansible Automation Platform)
This playbook is designed to run as an AAP Job Template, typically triggered automatically by Terraform after VM provisioning.

### Manual
```bash
ansible-playbook playbooks/install-nginx.yml -i <inventory>
```

## What it does
1. Installs nginx via `dnf`
2. Creates SSL directory (`/etc/nginx/ssl/`) for certificate deployment
3. Deploys a basic HTTP configuration
4. Configures firewall rules (HTTP/HTTPS)
5. Enables and starts the nginx service

## Integration with vault-ansible-clm
After nginx is installed, the [vault-ansible-clm](https://github.com/hashi-demo-lab/vault-ansible-clm) project's `cert_deploy` role handles:
- Issuing certificates from HashiCorp Vault PKI
- Deploying SSL certificates and keys
- Configuring nginx SSL server blocks
- Verifying TLS connectivity

## Requirements
- RHEL 9 target hosts
- Ansible collections: `ansible.posix >= 1.5.0`
