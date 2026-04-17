#!/usr/bin/env bash
# Renders templates/index.html.j2 + slides/*.html.j2 → templates/index.html
# so you can preview the deck in a browser via file:// without needing Ansible.
#
# Usage:  ./render-test.sh
# Opens:  templates/index.html   (the full rendered deck)
#         templates/assets/*     (symlinked to files/*, the authoritative source)

set -euo pipefail
cd "$(dirname "$0")"

python3 <<'PY'
import re
from pathlib import Path

TEMPLATES = Path('templates')
tpl = (TEMPLATES / 'index.html.j2').read_text()

# Resolve {% include '...' %} — the only Jinja control structure we use.
for _ in range(5):
    new = re.sub(
        r"\{%\s*include\s+['\"]([^'\"]+)['\"]\s*%\}",
        lambda m: (TEMPLATES / m.group(1)).read_text().rstrip('\n'),
        tpl,
    )
    if new == tpl:
        break
    tpl = new

# Substitute test values for any {{ variable }} used in partials.
tpl = tpl.replace('{{ inventory_hostname }}', 'clm-demo-01.ansible-vault.local')

leftover = re.findall(r'\{%.+?%\}|\{\{.+?\}\}', tpl)
if leftover:
    print(f'WARNING: unresolved jinja syntax: {leftover[:5]}')

(TEMPLATES / 'index.html').write_text(tpl)
print(f'Rendered templates/index.html: {len(tpl)} bytes, {tpl.count(chr(10))+1} lines')
PY

echo ""
echo "Open this URL in your browser:"
echo "  file://$(pwd)/templates/index.html"
