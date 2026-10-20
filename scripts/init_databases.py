"""Initialize the project databases inside Docker containers."""
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]

def run(command, stdin=None):
    print('$', ' '.join(command))
    return subprocess.run(command, cwd=ROOT, input=stdin, text=True, capture_output=True)

def wait_for_databases():
    checks = {
        'mysql': ['mysqladmin', 'ping', '-h127.0.0.1', '-uroot', '-p123456', '--silent'],
        'postgres': ['pg_isready', '-h127.0.0.1', '-U', 'agent_user', '-d', 'charge_identity_agent'],
    }
    for service, check in checks.items():
        for _ in range(30):
            if run(['docker', 'compose', 'exec', '-T', service, *check]).returncode == 0:
                print(f'{service} 已就绪')
                break
            time.sleep(2)
        else:
            logs = run(['docker', 'compose', 'logs', '--tail', '30', service])
            raise RuntimeError(f'{service} 在 60 秒内未就绪：{logs.stdout[-3000:]}')

def apply_mysql(path):
    result = run(['docker', 'compose', 'exec', '-T', 'mysql', 'mysql', '-h127.0.0.1', '-uroot', '-p123456'], path.read_text(encoding='utf-8-sig'))
    if result.returncode: raise RuntimeError(f'MySQL 执行失败：{result.stderr.strip()}')
    print(f'MySQL 已执行：{path.name}')

def apply_postgres(path):
    result = run(['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-U', 'agent_user', '-d', 'charge_identity_agent'], path.read_text(encoding='utf-8-sig'))
    if result.returncode: raise RuntimeError(f'PostgreSQL 执行失败：{result.stderr.strip()}')
    print(f'PostgreSQL 已执行：{path.name}')

def main():
    if shutil.which('docker') is None: raise RuntimeError('未找到 Docker')
    check = run(['docker', 'compose', 'config'])
    if check.returncode: raise RuntimeError(check.stderr.strip())
    started = run(['docker', 'compose', 'up', '-d', 'mysql', 'postgres'])
    if started.returncode: raise RuntimeError(started.stderr.strip())
    wait_for_databases()
    for name in ('001_mysql_identity.sql', '002_mysql_seed.sql'): apply_mysql(ROOT / 'database' / name)
    for name in ('001_postgres_ops.sql', '002_postgres_seed.sql'): apply_postgres(ROOT / 'database' / name)
    mysql = run(['docker', 'compose', 'exec', '-T', 'mysql', 'mysql', '-h127.0.0.1', '-uroot', '-p123456', '-D', 'charge_identity', '-Nse', 'SELECT COUNT(*) FROM users;'])
    postgres = run(['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-U', 'agent_user', '-d', 'charge_identity_agent', '-tAc', 'SELECT COUNT(*) FROM charging_piles;'])
    if mysql.returncode or postgres.returncode: raise RuntimeError('数据库校验失败')
    print(f'校验通过：MySQL users={mysql.stdout.strip()}，PostgreSQL charging_piles={postgres.stdout.strip()}')
    print('数据库初始化完成。')

if __name__ == '__main__':
    try: main()
    except Exception as exc:
        print(f'初始化失败：{exc}', file=sys.stderr)
        raise SystemExit(1)
