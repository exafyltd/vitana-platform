# VTID-04450: Apple Mail can send

Apple Mail in Connected Apps could only read. Gmail and Outlook Mail could
already send. This adds `email.send` for Apple Mail, over iCloud SMTP
(`smtp.mail.me.com:587`), with the Apple ID and app-specific password the
member already gave Vitanaland.

## Acceptance criteria

AC-1 The SMTP dialog switches to TLS (STARTTLS) before the password is sent. A server that does not offer STARTTLS is refused, and no AUTH is written.
TEST: services/gateway/test/vtid-04450-apple-mail-send.test.ts

AC-2 Authentication is AUTH PLAIN with the Apple ID and app-specific password. A rejected password comes back as `AppleAuthError`, the same as a rejected IMAP login.
TEST: services/gateway/test/vtid-04450-apple-mail-send.test.ts

AC-3 The From address is the member's Apple ID. When iCloud rejects that sender (an Apple ID that is not an iCloud address), the error is `icloud_sender_rejected` and comes with a hint.
TEST: services/gateway/test/vtid-04450-apple-mail-send.test.ts

AC-4 Recipients are split, de-duplicated and validated, with at most 20. A CR/LF injection attempt is rejected. Recipients the server refuses are dropped; if every recipient is refused, the send fails before DATA.
TEST: services/gateway/test/vtid-04450-apple-mail-send.test.ts

AC-5 The message is plain UTF-8 text in base64. The subject is RFC 2047 encoded only when it is not plain ASCII, and header line breaks are flattened. DATA ends with a lone dot.
TEST: services/gateway/test/vtid-04450-apple-mail-send.test.ts

AC-6 The Apple connector and the catalogue offer `email.send` for Apple Mail. The connector requires `to` and `subject`.
TEST: services/gateway/test/vtid-04450-apple-mail-send.test.ts

AC-7 The Apple sign-in text in the app now says what the password is used for: reading mail, calendar and contacts, sending mail when asked, and keeping the "Vitanaland" calendar current. The Apple Mail description mentions sending. Both are updated in all 11 locales (exafyltd/vitana-v1).
UI: vitana-v1 docs/validation/VTID-04449/outputs/mobile-de-2-apple-dialog.png

## Not verified

No mail was sent through a real iCloud account; there is no Apple test
account. The SMTP exchange follows Apple's published settings (port 587,
STARTTLS, app-specific password) and RFC 5321/4954, and is pinned against a
scripted server.
