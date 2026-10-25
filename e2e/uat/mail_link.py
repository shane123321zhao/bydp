"""
D-022 UAT：从专用测试邮箱（PO #26，Gmail + 应用专用密码）取 magic link。
用法（由 e2e/uat/login.ts 调用）：python3 -I e2e/uat/mail_link.py <收件地址> <起始 Unix 秒>
- 凭据只从环境变量 UAT_IMAP_USER / UAT_IMAP_APP_PASSWORD 读取；
- 同时搜收件箱与垃圾邮件夹（按 IMAP \\Junk 标记定位，中文界面文件夹名不固定）；
- 只取发给该地址、起始时间之后、主题含「登录链接」的最新一封；取到后标记已读并移入已删除；
- 只把链接写到标准输出交给调用方（不打印邮件正文），超时退出码 1。
"""
import email
import imaplib
import os
import re
import sys
import time
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime

to, since = sys.argv[1].lower(), int(sys.argv[2])
user, pw = os.environ.get("UAT_IMAP_USER", ""), os.environ.get("UAT_IMAP_APP_PASSWORD", "").replace(" ", "")
if not user or not pw:
    sys.exit("缺 UAT_IMAP_USER / UAT_IMAP_APP_PASSWORD")


def folders(m):
    out = ["INBOX"]
    for raw in m.list()[1]:
        line = raw.decode()
        if "\\Junk" in line:
            out.append(line.rsplit(' "/" ', 1)[-1])
    return out


def find(m):
    for f in folders(m):
        if m.select(f)[0] != "OK":
            continue
        day = time.strftime("%d-%b-%Y", time.gmtime(since - 86400))
        typ, data = m.search(None, f'(SINCE {day} TO "{to}")')
        for num in reversed(data[0].split() if typ == "OK" else []):
            msg = email.message_from_bytes(m.fetch(num, "(RFC822)")[1][0][1])
            subj = str(make_header(decode_header(msg.get("Subject", ""))))
            try:
                ts = parsedate_to_datetime(msg["Date"]).timestamp()
            except Exception:
                continue
            if "登录链接" not in subj or ts < since - 60:
                continue
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    body = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "replace")
                    link = re.search(r"https://\S+/api/auth/callback/resend\S+", body)
                    if link:
                        m.store(num, "+FLAGS", "\\Seen \\Deleted")
                        m.expunge()
                        return link.group(0)
    return None


deadline = time.time() + 180
while time.time() < deadline:
    m = imaplib.IMAP4_SSL("imap.gmail.com", 993, timeout=30)
    try:
        m.login(user, pw)
        link = find(m)
    finally:
        try:
            m.logout()
        except Exception:
            pass
    if link:
        sys.stdout.write(link)
        sys.exit(0)
    time.sleep(5)
sys.exit("180 秒内没有收到登录信")
