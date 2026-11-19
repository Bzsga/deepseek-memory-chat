import argparse
from getpass import getpass
import json
import sys
from decimal import Decimal

from .config import Settings, money
from .store import ServiceError, Store


def amount(value):
    try:
        parsed = Decimal(value)
    except ArithmeticError:
        raise argparse.ArgumentTypeError("请输入有限的非负人民币金额") from None
    if not parsed.is_finite() or not 0 <= parsed <= Decimal("100000000"):
        raise argparse.ArgumentTypeError("请输入有限的非负人民币金额")
    return money(parsed)


def main():
    parser = argparse.ArgumentParser(description="续聊助手本机邀请码和历史金额账务管理工具")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("bootstrap-admin", help="从标准输入读取一行密码，初始化保留账号 admin")
    commands.add_parser("rotate-admin-password", help="在服务器终端安全修改 admin 密码并退出旧会话")
    invite = commands.add_parser("invite", help="生成单次免费服务邀请码")
    invite.add_argument("--days", type=int, default=7)
    cap = commands.add_parser("cap", help="更新数据库预算上限")
    cap.add_argument("name", choices=["global", "monthly", "user", "per_job"])
    cap.add_argument("cny", type=amount)
    reconcile = commands.add_parser("reconcile", help="依据服务方账单结算不确定任务")
    reconcile.add_argument("job_id")
    reconcile.add_argument("--actual-cny", type=amount, required=True)
    commands.add_parser("uncertain", help="仅列出任务编号和账务信息")
    commands.add_parser("purge", help="立即删除到期原文和结果")
    args = parser.parse_args()
    settings = Settings.from_env()
    store = Store(settings)
    store.initialize()
    try:
        if args.command == "bootstrap-admin":
            password = sys.stdin.buffer.readline(1024).decode("utf-8").rstrip("\r\n")
            created = store.accounts.bootstrap_admin(password)
            print("管理员账号已创建。" if created else "管理员账号已存在。")
        elif args.command == "rotate-admin-password":
            if not sys.stdin.isatty():
                parser.error("请在交互终端运行，密码输入不回显。")
            password = getpass("新管理员密码：")
            if password != getpass("请再次输入："):
                parser.error("两次密码不一致，未修改。")
            store.accounts.rotate_admin_password(password)
            print("管理员密码已修改，旧会话已退出。")
        elif args.command == "invite":
            print(store.accounts.create_invites(1, args.days)["invitations"][0]["code"])
        elif args.command == "cap":
            store.set_cap(args.name, args.cny)
            print("历史邀请码金额上限已更新。公开免费模式按每周次数管理。")
        elif args.command == "reconcile":
            store.reconcile(args.job_id, args.actual_cny)
            print("已结算，任务不会自动重试。")
        elif args.command == "purge":
            print(f"已清理 {store.purge_expired()} 个到期任务的内容。")
        else:
            with store.connection() as db:
                rows = db.execute("SELECT id, owner_id, reserved, cost, created_at, cancel_requested FROM jobs WHERE status='uncertain'")
                print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
    except (ServiceError, ValueError, ArithmeticError) as error:
        parser.exit(2, f"操作失败：{error}\n")


if __name__ == "__main__":
    main()
