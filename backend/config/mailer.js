const path = require('path');
const dns = require('dns');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const normalizeEnv = (value) => (typeof value === 'string' ? value.trim() : '');
const EMAIL_USER = normalizeEnv(process.env.EMAIL_USER);
const EMAIL_PASS = normalizeEnv(process.env.EMAIL_PASS);
const MAIL_PROVIDER = (normalizeEnv(process.env.MAIL_PROVIDER) || 'gmail').toLowerCase();
const SMTP_USERNAME = normalizeEnv(process.env.SMTP_USER || process.env.SMTP_USERNAME || EMAIL_USER);
const SMTP_PASSWORD = normalizeEnv(process.env.SMTP_PASS || process.env.SMTP_PASSWORD || EMAIL_PASS);
const MAIL_FROM = normalizeEnv(process.env.MAIL_FROM || EMAIL_USER || 'startinnosolutions@gmail.com');
const MAIL_FROM_NAME = normalizeEnv(process.env.MAIL_FROM_NAME || 'StartInno Solutions');
const SMTP_HOST = normalizeEnv(process.env.SMTP_HOST || 'smtp.gmail.com');
const SMTP_PORT = Number(normalizeEnv(process.env.SMTP_PORT || '587'));
const SMTP_SECURE = String(normalizeEnv(process.env.SMTP_SECURE || 'false')).toLowerCase() === 'true';

const mailQueue = [];
let isMailQueueProcessing = false;

const enqueueMailJob = (taskFactory, label = 'mail') => {
  return new Promise((resolve, reject) => {
    mailQueue.push({ taskFactory, label, resolve, reject });
    if (!isMailQueueProcessing) {
      void processMailQueue();
    }
  });
};

const processMailQueue = async () => {
  if (isMailQueueProcessing) return;
  isMailQueueProcessing = true;

  while (mailQueue.length) {
    const job = mailQueue.shift();
    if (!job) continue;

    try {
      const result = await job.taskFactory();
      job.resolve(result);
    } catch (error) {
      console.error('[mailer] background job failed:', job.label, error.message);
      job.reject(error);
    }
  }

  isMailQueueProcessing = false;
};

const scheduleMail = (taskFactory, label = 'mail') => {
  const queuedAt = Date.now();
  const queuedPromise = enqueueMailJob(taskFactory, label);
  console.log(`[mailer] queued background job: ${label} at ${queuedAt}`);
  return queuedPromise;
};

const maskEmail = (email) => {
  if (!email || !email.includes('@')) return 'unset';
  const [localPart, domainPart] = email.split('@');
  const visibleLocal = localPart.slice(0, 2);
  return `${visibleLocal}${localPart.length > 2 ? '***' : ''}@${domainPart}`;
};

const isValidEmail = (email) => typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const normalizeFrontendBaseUrl = (value) => {
  const isDevelopment = (process.env.NODE_ENV || 'development') === 'development';
  const fallback = isDevelopment ? 'http://127.0.0.1:5001' : (process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || 'https://startinno-registration-1.onrender.com');

  if (!value || typeof value !== 'string') {
    return fallback;
  }

  const candidate = value
    .split(',')
    .map((item) => item.trim())
    .find((item) => /^https?:\/\//i.test(item) && !item.toLowerCase().startsWith('file://'));

  if (!candidate) {
    return fallback;
  }

  const stripped = candidate.replace(/\/+$/, '').replace(/\/frontend$/i, '');
  if (/^https?:\/\//i.test(stripped)) {
    if (/^http:\/\//i.test(stripped) && !/^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(stripped)) {
      return stripped.replace(/^http:/i, 'https:');
    }
    return stripped;
  }

  return `https://${stripped}`;
};

const normalizeRegistrationStatus = (status) => {
  const normalized = String(status || 'pending').trim().toLowerCase();
  if (normalized === 'approved') return 'approved';
  if (normalized === 'rejected') return 'rejected';
  return 'pending';
};

const statusConfig = {
  pending: {
    label: 'Pending Admin Approval',
    accent: '#F59E0B',
    glow: 'rgba(245, 158, 11, 0.24)',
    badgeBg: 'rgba(245, 158, 11, 0.16)',
    badgeText: '#FCD34D'
  },
  approved: {
    label: 'Approved',
    accent: '#22C55E',
    glow: 'rgba(34, 197, 94, 0.24)',
    badgeBg: 'rgba(34, 197, 94, 0.16)',
    badgeText: '#86EFAC'
  },
  rejected: {
    label: 'Rejected',
    accent: '#EF4444',
    glow: 'rgba(239, 68, 68, 0.24)',
    badgeBg: 'rgba(239, 68, 68, 0.16)',
    badgeText: '#FCA5A5'
  }
};

const getStatusConfig = (status) => statusConfig[normalizeRegistrationStatus(status)] || statusConfig.pending;

const buildEmailShell = ({ title, preheader, eyebrow, headline, intro, status, details, footerNote, ctaButtons = [] }) => {
  const theme = getStatusConfig(status);
  const buttonMarkup = ctaButtons.map((button) => `
    <a href="${escapeHtml(button.href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;vertical-align:middle;min-width:180px;max-width:100%;margin:0 8px 10px 0;padding:13px 20px;border-radius:999px;background:${button.primary ? 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)' : 'rgba(255,255,255,0.04)'};border:1px solid ${button.primary ? 'rgba(129,140,248,0.35)' : 'rgba(148,163,184,0.20)'};color:${button.primary ? '#ffffff' : '#E2E8F0'};text-decoration:none;text-align:center;font-size:14px;font-weight:700;line-height:1.2;box-shadow:${button.primary ? '0 12px 28px rgba(79,70,229,0.32)' : 'none'};box-sizing:border-box;'>${escapeHtml(button.label)}</a>
  `).join('');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta http-equiv="X-UA-Compatible" content="IE=edge" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="color-scheme" content="dark light" />
      <meta name="supported-color-schemes" content="dark light" />
      <title>${escapeHtml(title)}</title>
      <style>
        html, body { margin: 0 !important; padding: 0 !important; width: 100% !important; height: 100% !important; background: #0F172A; }
        * { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
        table, td { border-collapse: collapse; border-spacing: 0; }
        img { border: 0; line-height: 100%; outline: none; text-decoration: none; }
        a { text-decoration: none; }
        @media screen and (max-width: 640px) {
          .container { width: 100% !important; }
          .pad { padding-left: 18px !important; padding-right: 18px !important; }
          .stack { display: block !important; width: 100% !important; }
          .button-group a { display: block !important; margin-right: 0 !important; }
        }
      </style>
    </head>
    <body style="margin:0;padding:0;background:#0F172A;font-family:Inter,Segoe UI,Arial,sans-serif;color:#E2E8F0;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:radial-gradient(circle at top, rgba(79,70,229,0.18), transparent 28%), radial-gradient(circle at bottom right, rgba(124,58,237,0.16), transparent 26%), #0F172A;">
        <tr>
          <td align="center" style="padding:32px 14px;">
            <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" class="container" style="width:100%;max-width:640px;overflow:hidden;border-radius:28px;background:rgba(15,23,42,0.92);border:1px solid rgba(148,163,184,0.18);box-shadow:0 24px 70px rgba(2,6,23,0.48);">
              <tr>
                <td style="padding:0;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="background:linear-gradient(135deg, #4F46E5 0%, #7C3AED 55%, #0F172A 100%);padding:24px 30px 26px;">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                          <tr>
                            <td valign="middle" style="width:64px;padding-right:16px;">
                              <div style="width:64px;height:64px;border-radius:20px;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.18);color:#ffffff;text-align:center;line-height:64px;font-size:30px;box-shadow:0 14px 36px ${theme.glow};">SI</div>
                            </td>
                            <td valign="middle">
                              <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;font-weight:800;color:rgba(255,255,255,0.78);margin-bottom:6px;">StartInno Solutions</div>
                              <div style="font-size:28px;line-height:1.15;font-weight:800;color:#ffffff;">${escapeHtml(headline)}</div>
                              <div style="margin-top:8px;font-size:14px;line-height:1.7;color:rgba(255,255,255,0.82);">${escapeHtml(intro)}</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td class="pad" style="padding:30px 32px 18px;">
                        <div style="display:inline-block;margin-bottom:18px;padding:8px 14px;border-radius:999px;background:${theme.badgeBg};border:1px solid rgba(255,255,255,0.08);color:${theme.badgeText};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:800;">${escapeHtml(eyebrow || theme.label)}</div>
                        <div style="font-size:16px;line-height:1.8;color:#CBD5E1;margin-bottom:18px;">${escapeHtml(details?.summary || '')}</div>
                        ${details?.bodyHtml || ''}
                      </td>
                    </tr>
                    <tr>
                      <td class="pad" style="padding:0 32px 8px;">
                        ${buttonMarkup ? `<div class="button-group" style="margin:10px 0 6px;">${buttonMarkup}</div>` : ''}
                      </td>
                    </tr>
                    <tr>
                      <td class="pad" style="padding:10px 32px 30px;">
                        <div style="padding:18px 18px 16px;border-radius:18px;background:rgba(255,255,255,0.03);border:1px solid rgba(148,163,184,0.16);">
                          <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:800;color:#A5B4FC;margin-bottom:10px;">Support</div>
                          <div style="font-size:14px;line-height:1.8;color:#CBD5E1;">If you need help, please visit the Help Section or open a ticket from the dashboard. Our support team will respond as soon as possible.</div>
                        </div>
                        <div style="margin-top:18px;font-size:12px;line-height:1.8;color:rgba(226,232,240,0.68);">${escapeHtml(footerNote || 'StartInno Solutions')}
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
};

const getMemberName = (member) => member?.name || member?.fullName || member?.leaderName || member?.memberName || '—';

const getMemberEmail = (member) => member?.email || member?.mail || member?.contactEmail || '—';

const getMemberPhone = (member) => member?.phone || member?.contact || member?.mobile || '—';

const normalizeRecipientEmail = (value) => String(value || '').trim().toLowerCase();

const collectRegistrationRecipients = ({ leaderEmail, leaderName, members }) => {
  const list = [];
  const invalidRecipients = [];
  const seen = new Set();

  const addRecipient = (email, name, role) => {
    const normalized = normalizeRecipientEmail(email);
    if (!normalized) return;
    if (!isValidEmail(normalized)) {
      invalidRecipients.push(normalized);
      return;
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    list.push({ email: normalized, name: name || normalized, role });
  };

  addRecipient(leaderEmail, leaderName, 'leader');

  const memberList = Array.isArray(members) ? members : [];
  memberList.forEach((member, index) => {
    addRecipient(member?.email || member?.mail || member?.contactEmail, getMemberName(member), `member-${index + 1}`);
  });

  return { recipients: list, invalidRecipients };
};

const sendRegistrationEmailBatch = async ({ recipients, subject, htmlFactory, textFactory, contextLabel }) => {
  const uniqueRecipients = Array.isArray(recipients) ? recipients : [];
  console.log(`[mailer] ${contextLabel} recipients:`, uniqueRecipients.map((recipient) => recipient.email));

  if (!uniqueRecipients.length) {
    return {
      totalRecipients: 0,
      sentCount: 0,
      failedCount: 0,
      queuedCount: 0,
      sentRecipients: [],
      failedRecipients: [],
      invalidRecipients: []
    };
  }

  uniqueRecipients.forEach((recipient) => {
    void sendMail(
      {
        from: getSender(),
        to: recipient.email,
        subject,
        html: htmlFactory(recipient),
        text: typeof textFactory === 'function' ? textFactory(recipient) : undefined
      },
      { waitForDelivery: false, queueLabel: `${contextLabel}:${recipient.email}` }
    ).then(() => {
      console.log(`[mailer] ${contextLabel} queued:`, recipient.email);
    }).catch((error) => {
      console.error(`[mailer] ${contextLabel} queue failed:`, recipient.email, error.message);
    });
  });

  return {
    totalRecipients: uniqueRecipients.length,
    sentCount: 0,
    failedCount: 0,
    queuedCount: uniqueRecipients.length,
    sentRecipients: [],
    failedRecipients: [],
    invalidRecipients: []
  };
};

const buildMembersHtml = (members) => {
  const list = Array.isArray(members) ? members : [];
  if (!list.length) {
    return '<tr><td colspan="4" style="padding:14px 16px;color:#94A3B8;">No additional team members provided.</td></tr>';
  }

  return list.map((member, index) => `
    <tr>
      <td style="padding:12px 16px;border-top:1px solid rgba(148,163,184,0.14);color:#E2E8F0;font-weight:700;width:52px;">${index + 2}</td>
      <td style="padding:12px 16px;border-top:1px solid rgba(148,163,184,0.14);color:#E2E8F0;">${escapeHtml(getMemberName(member))}</td>
      <td style="padding:12px 16px;border-top:1px solid rgba(148,163,184,0.14);color:#CBD5E1;">${escapeHtml(getMemberEmail(member))}</td>
      <td style="padding:12px 16px;border-top:1px solid rgba(148,163,184,0.14);color:#CBD5E1;">${escapeHtml(getMemberPhone(member))}</td>
    </tr>
  `).join('');
};

const buildTeamDetailsTable = ({ teamName, leaderName, email, contact, stream, year, collegeName, members, paymentMethod, paymentReference, transactionId, paymentStatus, registrationStatus, refundStatus }) => {
  const safeMembers = Array.isArray(members) ? members : [];
  const primaryLeader = safeMembers[0] || {};
  const leadEmail = email || primaryLeader.email || '—';
  const leadPhone = getMemberPhone(primaryLeader) !== '—' ? getMemberPhone(primaryLeader) : (contact || '—');
  const memberNames = safeMembers.length ? safeMembers.map((member) => getMemberName(member)).join(', ') : '—';
  const memberEmails = safeMembers.length ? Array.from(new Set([leadEmail, ...safeMembers.map((member) => getMemberEmail(member))].filter(Boolean))).join(', ') : leadEmail;
  const memberPhones = safeMembers.length ? Array.from(new Set([leadPhone, ...safeMembers.map((member) => getMemberPhone(member))].filter(Boolean))).join(', ') : leadPhone;

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:4px;border-radius:20px;overflow:hidden;background:rgba(15,23,42,0.72);border:1px solid rgba(148,163,184,0.16);">
      <tr>
        <td style="padding:18px 18px 10px;background:rgba(255,255,255,0.02);border-bottom:1px solid rgba(148,163,184,0.12);">
          <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:800;color:#A5B4FC;">Team Details</div>
        </td>
      </tr>
      <tr>
        <td style="padding:0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">Team Name</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#FFFFFF;font-weight:700;">${escapeHtml(teamName || '—')}</td>
            </tr>
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">Team Leader</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#FFFFFF;font-weight:700;">${escapeHtml(leaderName || '—')}</td>
            </tr>
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">Team Members</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#CBD5E1;">${escapeHtml(memberNames)}</td>
            </tr>
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">Emails</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#CBD5E1;">${escapeHtml(memberEmails)}</td>
            </tr>
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">Phone Numbers</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#CBD5E1;">${escapeHtml(memberPhones)}</td>
            </tr>
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">Stream</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#CBD5E1;">${escapeHtml(stream || '—')}</td>
            </tr>
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">Year</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#CBD5E1;">${escapeHtml(year || '—')}</td>
            </tr>
            ${collegeName ? `
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">College Name</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#CBD5E1;">${escapeHtml(collegeName)}</td>
            </tr>` : ''}
            ${paymentMethod || paymentReference || transactionId ? `
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">Payment Method</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#CBD5E1;">${escapeHtml(paymentMethod || '—')}</td>
            </tr>
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">Transaction ID</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#CBD5E1;">${escapeHtml(paymentReference || transactionId || '—')}</td>
            </tr>` : ''}
            ${paymentStatus ? `
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">Payment Status</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#CBD5E1;">${escapeHtml(paymentStatus)}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">Registration Status</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#FFFFFF;font-weight:800;">${escapeHtml(getStatusConfig(registrationStatus).label)}</td>
            </tr>
            ${refundStatus ? `
            <tr>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);width:38%;color:#94A3B8;">Refund Status</td>
              <td style="padding:14px 18px;border-top:1px solid rgba(148,163,184,0.12);color:#CBD5E1;">${escapeHtml(refundStatus)}</td>
            </tr>` : ''}
          </table>
        </td>
      </tr>
      ${safeMembers.length ? `
      <tr>
        <td style="padding:0 0 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:0;">
            <tr>
              <td style="padding:18px 18px 10px;background:rgba(255,255,255,0.02);border-top:1px solid rgba(148,163,184,0.12);">
                <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:800;color:#A5B4FC;">Team Members</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
                  <tr>
                    <td style="padding:12px 16px;border-top:1px solid rgba(148,163,184,0.12);color:#94A3B8;font-weight:700;width:52px;">#</td>
                    <td style="padding:12px 16px;border-top:1px solid rgba(148,163,184,0.12);color:#94A3B8;font-weight:700;">Name</td>
                    <td style="padding:12px 16px;border-top:1px solid rgba(148,163,184,0.12);color:#94A3B8;font-weight:700;">Email</td>
                    <td style="padding:12px 16px;border-top:1px solid rgba(148,163,184,0.12);color:#94A3B8;font-weight:700;">Phone</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 16px;border-top:1px solid rgba(148,163,184,0.12);color:#E2E8F0;font-weight:700;width:52px;">1</td>
                    <td style="padding:12px 16px;border-top:1px solid rgba(148,163,184,0.12);color:#E2E8F0;">${escapeHtml(leaderName || '—')}</td>
                    <td style="padding:12px 16px;border-top:1px solid rgba(148,163,184,0.12);color:#CBD5E1;">${escapeHtml(leadEmail)}</td>
                    <td style="padding:12px 16px;border-top:1px solid rgba(148,163,184,0.12);color:#CBD5E1;">${escapeHtml(leadPhone)}</td>
                  </tr>
                  ${buildMembersHtml(safeMembers.slice(1))}
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>` : ''}
    </table>
  `;
};

const ipv4Lookup = (hostname, options, callback) => {
  const lookupOptions = {
    all: false,
    family: 4,
    ...options
  };

  dns.lookup(hostname, lookupOptions, (error, address, family) => {
    if (callback) {
      callback(error, address, family);
    }
  });
};

const createTransporter = () => {
  const provider = MAIL_PROVIDER;
  const smtpHost = normalizeEnv(process.env.SMTP_HOST || '');
  const smtpPort = Number(normalizeEnv(process.env.SMTP_PORT || '587'));
  const smtpSecure = String(normalizeEnv(process.env.SMTP_SECURE || 'false')).toLowerCase() === 'true';

  const baseTransportConfig = {
    pool: true,
    maxConnections: 3,
    maxMessages: 20,
    connectionTimeout: 20000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    family: 4,
    lookup: ipv4Lookup
  };

  if (provider === 'sendgrid' && process.env.SENDGRID_API_KEY) {
    console.log('[mailer] using sendgrid smtp transport');
    return nodemailer.createTransport({
      ...baseTransportConfig,
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: 'apikey',
        pass: process.env.SENDGRID_API_KEY
      }
    });
  }

  if (provider === 'resend' && process.env.RESEND_API_KEY) {
    console.log('[mailer] using resend smtp transport');
    return nodemailer.createTransport({
      ...baseTransportConfig,
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      requireTLS: true,
      auth: {
        user: 'resend',
        pass: process.env.RESEND_API_KEY
      }
    });
  }

  if (smtpHost) {
    return nodemailer.createTransport({
      ...baseTransportConfig,
      host: smtpHost,
      port: smtpPort || 587,
      secure: smtpSecure,
      requireTLS: true,
      auth: {
        user: SMTP_USERNAME,
        pass: SMTP_PASSWORD
      }
    });
  }

  return nodemailer.createTransport({
    ...baseTransportConfig,
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: SMTP_USERNAME,
      pass: SMTP_PASSWORD
    }
  });
};

const transporter = createTransporter();

console.log('[mailer] SMTP user configured:', Boolean(SMTP_USERNAME || EMAIL_USER));
console.log('[mailer] SMTP password configured:', Boolean(SMTP_PASSWORD || EMAIL_PASS));
console.log('[mailer] SMTP user:', maskEmail(SMTP_USERNAME || EMAIL_USER));
console.log('[mailer] mail provider:', MAIL_PROVIDER);
console.log('[mailer] SMTP transport:', process.env.SMTP_HOST ? `${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}` : (MAIL_PROVIDER === 'sendgrid' ? 'sendgrid' : 'gmail/smtp.gmail.com'));
console.log('[mailer] SMTP credentials source:', SMTP_USERNAME === EMAIL_USER && (SMTP_PASSWORD === EMAIL_PASS || !SMTP_PASSWORD) ? 'EMAIL_USER/EMAIL_PASS' : 'SMTP_USER/SMTP_PASS');
console.log('[mailer] SMTP family:', transporter.options.family || 4);
console.log('[mailer] Gmail app password guidance:', SMTP_HOST.includes('gmail') ? 'Ensure EMAIL_PASS or SMTP_PASS is a Gmail app password, not your normal Gmail password.' : 'Using custom SMTP provider.');
console.log('[mailer] frontend base URL:', normalizeFrontendBaseUrl(process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL));

const getSender = () => {
  if (!MAIL_FROM || MAIL_FROM === 'undefined') return 'startinnosolutions@gmail.com';
  if (MAIL_FROM_NAME && MAIL_FROM_NAME !== 'undefined') return `${MAIL_FROM_NAME} <${MAIL_FROM}>`;
  return MAIL_FROM;
};

const verifyTransporter = async () => {
  if (!SMTP_USERNAME || !SMTP_PASSWORD) {
    console.error('[mailer] SMTP verify skipped: missing SMTP credentials');
    return false;
  }

  const transportDetails = {
    host: transporter.options?.host || SMTP_HOST || 'smtp.gmail.com',
    port: transporter.options?.port || SMTP_PORT || 587,
    secure: transporter.options?.secure ?? SMTP_SECURE,
    family: transporter.options?.family || 4,
    authUser: maskEmail(SMTP_USERNAME || EMAIL_USER)
  };

  console.log('[mailer] verifying SMTP connectivity', transportDetails);

  try {
    await transporter.verify();
    console.log('[mailer] SMTP connection verified successfully', transportDetails);
    return true;
  } catch (error) {
    console.error('[mailer] SMTP verify failed:', {
      ...transportDetails,
      message: error.message,
      code: error.code,
      response: error.response,
      stack: error.stack
    });
    return false;
  }
};

void verifyTransporter().catch((error) => {
  console.error('[mailer] SMTP startup verification error:', error.message);
});

const sendMail = async (mailOptions, { waitForDelivery = false, queueLabel = 'mail' } = {}) => {
  const recipientList = Array.isArray(mailOptions.to) ? mailOptions.to : [mailOptions.to];
  const effectiveOptions = {
    ...mailOptions,
    from: mailOptions.from || getSender(),
    replyTo: mailOptions.replyTo || EMAIL_USER || undefined
  };

  console.log('[mailer] sendMail requested', {
    to: recipientList,
    subject: effectiveOptions.subject,
    from: effectiveOptions.from,
    replyTo: effectiveOptions.replyTo,
    mailOptions: {
      ...effectiveOptions,
      html: effectiveOptions.html ? '[html content]' : undefined,
      text: effectiveOptions.text ? '[text content]' : undefined
    }
  });

  if (waitForDelivery) {
    try {
      console.log('[mailer] sending email directly to:', recipientList);
      const info = await transporter.sendMail(effectiveOptions);
      console.log('[mailer] sendMail success', {
        to: recipientList,
        messageId: info.messageId,
        response: info.response,
        accepted: info.accepted,
        rejected: info.rejected,
        subject: effectiveOptions.subject
      });
      return info;
    } catch (error) {
      console.error('[mailer] sendMail failed', {
        to: recipientList,
        subject: effectiveOptions.subject,
        from: effectiveOptions.from,
        host: transporter.options?.host || SMTP_HOST || 'smtp.gmail.com',
        port: transporter.options?.port || SMTP_PORT || 587,
        secure: transporter.options?.secure ?? SMTP_SECURE,
        family: transporter.options?.family || 4,
        message: error.message,
        code: error.code,
        response: error.response,
        stack: error.stack
      });
      throw error;
    }
  }

  return scheduleMail(async () => {
    try {
      console.log('[mailer] sending queued email to:', recipientList);
      const info = await transporter.sendMail(effectiveOptions);
      console.log('[mailer] queued delivery completed:', {
        to: recipientList,
        messageId: info.messageId,
        response: info.response,
        accepted: info.accepted,
        rejected: info.rejected,
        subject: effectiveOptions.subject
      });
      return info;
    } catch (error) {
      console.error('[mailer] queued sendMail failed', {
        to: recipientList,
        subject: effectiveOptions.subject,
        from: effectiveOptions.from,
        host: transporter.options?.host || SMTP_HOST || 'smtp.gmail.com',
        port: transporter.options?.port || SMTP_PORT || 587,
        secure: transporter.options?.secure ?? SMTP_SECURE,
        family: transporter.options?.family || 4,
        message: error.message,
        code: error.code,
        response: error.response,
        stack: error.stack
      });
      throw error;
    }
  }, queueLabel);
};

const buildForgotUsernameEmailHtml = ({ username, helpCenterUrl, currentYear }) => {
  const safeUsername = escapeHtml(username || 'there');
  const safeHelpCenterUrl = escapeHtml(helpCenterUrl);
  const yearText = escapeHtml(currentYear);

  return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #f8fafc; border-radius: 12px; color: #0f172a;">
        <h2 style="margin: 0 0 16px;">Your Username</h2>
        <p style="margin: 0 0 20px; line-height: 1.6;">We received a request to retrieve your username. Here is the account identifier associated with your email address.</p>
        <div style="background: #fff; border: 1px solid #cbd5e1; border-radius: 10px; padding: 18px; text-align: center; margin-bottom: 18px;">
          <div style="font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #64748b; margin-bottom: 8px;">Your Username</div>
          <div style="font-size: 24px; font-weight: 700; color: #2563eb; font-family: monospace;">${safeUsername}</div>
        </div>
        <div style="background: #eff6ff; border-left: 4px solid #2563eb; padding: 14px 16px; border-radius: 8px; line-height: 1.7; color: #1e3a8a;">
          To sign in, go to the login page, enter this username, then use your password as usual. If you need support, use the Help Section below to raise an issue.
        </div>
        <div style="margin-top: 22px; text-align: center;">
          <a href="${safeHelpCenterUrl}" style="display:inline-block; padding:13px 24px; font-size:14px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:999px; background:linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);">Visit Help Section</a>
        </div>
        <div style="margin-top: 22px; padding-top: 14px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 12px; line-height: 1.7;">
          © StartInno Solutions ${yearText}
        </div>
      </div>
    `;
};

const sendUsernameEmail = async (email, username, baseUrl = process.env.FRONTEND_URL || 'http://localhost:5000') => {
  if (!isValidEmail(email)) {
    const error = new Error('Invalid email address');
    error.statusCode = 400;
    throw error;
  }

  const normalizedBaseUrl = normalizeFrontendBaseUrl(baseUrl || process.env.FRONTEND_URL);
  const helpCenterUrl = process.env.HELP_CENTER_URL || `${normalizedBaseUrl}/user/help.html`;
  const currentYear = new Date().getFullYear();

  const mailOptions = {
    from: getSender(),
    to: email,
    subject: 'Your StartInno Solutions Username',
    html: buildForgotUsernameEmailHtml({
      username,
      helpCenterUrl,
      currentYear
    })
  };

  return sendMail(mailOptions, { waitForDelivery: true });
};

const buildRegistrationActions = (baseUrl) => ([
  { label: 'Visit Dashboard', href: `${baseUrl}/dashboard`, primary: true },
  { label: 'Help Section', href: `${baseUrl}/help`, primary: false },
  { label: 'Track Registration', href: `${baseUrl}/track-registration`, primary: false }
]);

const buildRegistrationSubmittedHtml = ({
  email,
  teamName,
  leaderName,
  contact,
  year,
  stream,
  members,
  paymentMethod,
  paymentReference,
  transactionId,
  registrationStatus,
  baseUrl,
  collegeName,
  recipientName,
  recipientEmail
}) => {
  const normalizedBaseUrl = normalizeFrontendBaseUrl(baseUrl || process.env.FRONTEND_URL || 'http://127.0.0.1:5500');
  const safeStatus = normalizeRegistrationStatus(registrationStatus || 'pending');
  const leader = leaderName || (Array.isArray(members) ? getMemberName(members[0]) : '—');
  const greetingName = recipientName || leader || 'there';
  return buildEmailShell({
    title: 'Hackathon Registration Submitted Successfully | StartInno Solutions',
    preheader: 'Your StartInno Solutions hackathon registration has been submitted and is pending admin verification.',
    eyebrow: 'Registration Submitted',
    headline: 'Hackathon Registration Submitted Successfully',
    intro: `Hello ${greetingName}, thank you for registering with StartInno Solutions.`,
    status: safeStatus,
    details: {
      summary: 'Your registration has been successfully submitted and is currently under processing for admin verification.',
      bodyHtml: buildTeamDetailsTable({
        teamName,
        leaderName,
        email: recipientEmail || email,
        contact,
        stream,
        year,
        members,
        paymentMethod,
        paymentReference,
        transactionId,
        registrationStatus: safeStatus
      })
    },
    footerNote: 'We appreciate your patience and look forward to having your team participate in the innovation journey. - StartInno Solutions Team',
    ctaButtons: buildRegistrationActions(normalizedBaseUrl)
  });
};

const buildRegistrationApprovedHtml = ({
  teamName,
  leaderName,
  email,
  contact,
  year,
  stream,
  collegeName,
  members,
  paymentMethod,
  paymentReference,
  transactionId,
  registrationStatus,
  baseUrl,
  paymentStatus,
  recipientName
}) => {
  const normalizedBaseUrl = normalizeFrontendBaseUrl(baseUrl || process.env.FRONTEND_URL || 'http://127.0.0.1:5500');
  const safeStatus = normalizeRegistrationStatus(registrationStatus || 'approved');
  const leader = leaderName || (Array.isArray(members) ? getMemberName(members[0]) : '—');
  const greetingName = recipientName || leader || 'there';
  return buildEmailShell({
    title: 'Registration Approved | StartInno Solutions Hackathon',
    preheader: 'Your StartInno Solutions hackathon registration has been approved.',
    eyebrow: 'Registration Approved',
    headline: 'Registration Approved',
    intro: `Hello ${greetingName}, thank you for your patience.`,
    status: safeStatus,
    details: {
      summary: 'We are excited to inform you that your hackathon registration has been APPROVED successfully. Your slot has now been officially confirmed for the StartInno Solutions Hackathon.',
      bodyHtml: buildTeamDetailsTable({
        teamName,
        leaderName,
        email,
        contact,
        stream,
        year,
        collegeName,
        members,
        paymentMethod,
        paymentReference,
        transactionId,
        paymentStatus: paymentStatus || 'Completed',
        registrationStatus: safeStatus
      })
    },
    footerNote: 'We look forward to seeing your team innovate and build amazing solutions. - StartInno Solutions',
    ctaButtons: buildRegistrationActions(normalizedBaseUrl)
  });
};

const buildRegistrationRejectedHtml = ({
  teamName,
  leaderName,
  email,
  contact,
  year,
  stream,
  members,
  paymentMethod,
  paymentReference,
  transactionId,
  registrationStatus,
  baseUrl,
  refundStatus,
  recipientName
}) => {
  const normalizedBaseUrl = normalizeFrontendBaseUrl(baseUrl || process.env.FRONTEND_URL || 'http://127.0.0.1:5500');
  const safeStatus = normalizeRegistrationStatus(registrationStatus || 'rejected');
  const leader = leaderName || (Array.isArray(members) ? getMemberName(members[0]) : '—');
  const greetingName = recipientName || leader || 'there';
  const paymentLabel = paymentMethod || '—';
  return buildEmailShell({
    title: 'Registration Rejected | StartInno Solutions Hackathon',
    preheader: 'Your StartInno Solutions hackathon registration has been rejected after review.',
    eyebrow: 'Registration Rejected',
    headline: 'Registration Rejected',
    intro: `Hello ${greetingName}, thank you for your patience.`,
    status: safeStatus,
    details: {
      summary: 'We regret to inform you that your hackathon registration has been rejected after review. If payment was completed, your amount will be credited back to your bank account within 7–9 working days.',
      bodyHtml: buildTeamDetailsTable({
        teamName,
        leaderName,
        email,
        contact,
        year,
        stream,
        members,
        paymentMethod: paymentLabel,
        paymentReference,
        transactionId,
        paymentStatus: paymentReference || transactionId ? 'Paid / Under Refund Review' : 'Not Paid',
        refundStatus: refundStatus || 'Refund processing (if applicable)',
        registrationStatus: safeStatus
      })
    },
    footerNote: 'We sincerely appreciate your interest in StartInno Solutions and hope to see you in future events. - StartInno Solutions',
    ctaButtons: buildRegistrationActions(normalizedBaseUrl)
  });
};

const sendRegistrationSubmittedEmail = async (payload) => {
  const { recipients, invalidRecipients } = collectRegistrationRecipients({
    leaderEmail: payload.email,
    leaderName: payload.leaderName,
    members: payload.members
  });

  if (invalidRecipients.length) {
    console.warn('[mailer] submitted invalid recipients:', invalidRecipients);
  }

  return sendRegistrationEmailBatch({
    recipients,
    subject: '🎉 Hackathon Registration Submitted Successfully | StartInno Solutions',
    contextLabel: 'registration-submitted',
    htmlFactory: (recipient) => buildRegistrationSubmittedHtml({ ...payload, recipientName: recipient.name, recipientEmail: recipient.email }),
    textFactory: (recipient) => `Hello ${recipient.name || 'there'},\n\nThank you for registering for the hackathon conducted by StartInno Solutions. Your registration has been submitted successfully and is currently under admin review. All further updates regarding approval or rejection will be sent to your registered email address.`,
  });
};

const sendRegistrationConfirmationEmail = async (payload) => sendRegistrationSubmittedEmail(payload);

const sendRegistrationApprovedEmail = async ({
  email,
  teamName,
  leaderName,
  year,
  stream,
  members,
  paymentMethod,
  paymentReference,
  transactionId,
  registrationStatus,
  baseUrl,
  collegeName,
  paymentStatus,
  whatsappJoined,
  contact
}) => {
  const { recipients, invalidRecipients } = collectRegistrationRecipients({
    leaderEmail: email,
    leaderName,
    members
  });

  if (invalidRecipients.length) {
    console.warn('[mailer] approved invalid recipients:', invalidRecipients);
  }

  return sendRegistrationEmailBatch({
    recipients,
    subject: '✅ Registration Approved | StartInno Solutions Hackathon',
    contextLabel: 'registration-approved',
    htmlFactory: (recipient) => buildRegistrationApprovedHtml({
      teamName,
      leaderName,
      email,
      contact,
      stream,
      year,
      collegeName,
      members,
      paymentMethod,
      paymentReference,
      transactionId,
      paymentStatus,
      registrationStatus,
      baseUrl,
      recipientName: recipient.name
    }),
    textFactory: (recipient) => `Hello ${recipient.name || 'there'},\n\nThank you for your patience. We are excited to inform you that your hackathon registration has been approved successfully. Your slot has now been officially confirmed for the StartInno Solutions Hackathon.`,
  });
};

const sendRegistrationRejectedEmail = async ({
  email,
  teamName,
  leaderName,
  year,
  stream,
  members,
  paymentMethod,
  paymentReference,
  transactionId,
  registrationStatus,
  baseUrl,
  refundStatus,
  contact
}) => {
  const { recipients, invalidRecipients } = collectRegistrationRecipients({
    leaderEmail: email,
    leaderName,
    members
  });

  if (invalidRecipients.length) {
    console.warn('[mailer] rejected invalid recipients:', invalidRecipients);
  }

  return sendRegistrationEmailBatch({
    recipients,
    subject: '❌ Registration Rejected | StartInno Solutions Hackathon',
    contextLabel: 'registration-rejected',
    htmlFactory: (recipient) => buildRegistrationRejectedHtml({
      teamName,
      leaderName,
      email,
      contact,
      year,
      stream,
      members,
      paymentMethod,
      paymentReference,
      transactionId,
      registrationStatus,
      baseUrl,
      refundStatus,
      recipientName: recipient.name
    }),
    textFactory: (recipient) => `Hello ${recipient.name || 'there'},\n\nThank you for your patience. We regret to inform you that your hackathon registration has been rejected after review.`,
  });
};

const buildPasswordResetEmailHtml = ({ username, resetLink, helpCenterUrl, securityAlertUrl, currentYear }) => {
  const safeUsername = escapeHtml(username || 'there');
  const safeResetLink = escapeHtml(resetLink);
  const safeHelpCenterUrl = escapeHtml(helpCenterUrl);
  const safeSecurityAlertUrl = escapeHtml(securityAlertUrl);
  const yearText = escapeHtml(currentYear);

  return `
    <!DOCTYPE html>
    <html lang="en" xmlns="http://www.w3.org/1999/xhtml">
    <head>
      <meta charset="UTF-8" />
      <meta http-equiv="X-UA-Compatible" content="IE=edge" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="color-scheme" content="dark light" />
      <meta name="supported-color-schemes" content="dark light" />
      <title>StartInno Solutions - Password Reset</title>
    </head>
    <body style="margin:0; padding:0; background-color:#0f0f1a; font-family:Inter, 'Segoe UI', Arial, sans-serif; color:#e2e8f0;">
      <div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">
        Password reset request for ${safeUsername}. Follow the secure steps inside the email to reset your account.
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:collapse; background-color:#0f0f1a; background-image:radial-gradient(circle at top left, rgba(79,70,229,0.18), transparent 28%), radial-gradient(circle at bottom right, rgba(124,58,237,0.16), transparent 26%);">
        <tr>
          <td align="center" style="padding:32px 16px;">
            <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%; max-width:600px; border-collapse:separate; border-spacing:0;">
              <tr>
                <td style="border-radius:28px; overflow:hidden; background-color:#1a1a2e; border:1px solid rgba(148,163,184,0.18); box-shadow:0 24px 64px rgba(2,6,23,0.45);">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:collapse;">
                    <tr>
                      <td style="padding:28px 30px 24px; background:linear-gradient(135deg, #0b1020 0%, #111633 45%, #1f1b4b 100%); border-bottom:1px solid rgba(148,163,184,0.14);">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:collapse;">
                          <tr>
                            <td valign="middle" style="width:56px; padding-right:14px;">
                              <div style="width:56px; height:56px; border-radius:18px; background:linear-gradient(135deg, rgba(79,70,229,0.25), rgba(124,58,237,0.26)); border:1px solid rgba(167,139,250,0.32); color:#c4b5fd; font-size:28px; line-height:56px; text-align:center;">&#128737;</div>
                            </td>
                            <td valign="middle" style="text-align:left;">
                              <div style="font-size:12px; letter-spacing:0.18em; text-transform:uppercase; color:#a5b4fc; font-weight:700; margin-bottom:6px;">StartInno Solutions</div>
                              <div style="font-size:26px; line-height:1.15; font-weight:800; color:#f8fafc; font-family:'Segoe UI', Arial, sans-serif;">Password Reset Request</div>
                              <div style="font-size:13px; color:rgba(226,232,240,0.82); margin-top:6px;">Secure · Trusted · Innovative</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:30px;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:collapse;">
                          <tr>
                            <td align="center" style="padding-bottom:22px;">
                              <div style="width:92px; height:92px; border-radius:28px; background:linear-gradient(135deg, rgba(79,70,229,0.18), rgba(124,58,237,0.22)); border:1px solid rgba(129,140,248,0.28); box-shadow:0 18px 40px rgba(79,70,229,0.18); font-size:44px; line-height:92px; color:#c4b5fd; text-align:center;">&#128272;</div>
                            </td>
                          </tr>
                          <tr>
                            <td align="center" style="padding-bottom:12px;">
                              <div style="font-size:28px; line-height:1.2; font-weight:800; color:#f8fafc;">Password Reset Request</div>
                            </td>
                          </tr>
                          <tr>
                            <td align="center" style="padding-bottom:22px;">
                              <div style="max-width:490px; margin:0 auto; font-size:16px; line-height:1.75; color:rgba(226,232,240,0.84);">
                                We received a request to reset the account credentials for <strong style="color:#f8fafc;">${safeUsername}</strong>. If this was you, follow the steps below to secure your account.
                              </div>
                            </td>
                          </tr>
                          <tr>
                            <td style="padding:0 4px 20px;">
                              <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(148,163,184,0.16); border-radius:20px; padding:20px 22px; color:#e2e8f0; line-height:1.75; font-size:15px;">
                                Thank you for contacting StartInno Solutions. We're here to help you regain access to your account securely.
                                <ol style="margin:14px 0 0; padding-left:20px; color:#e2e8f0;">
                                  <li style="margin-bottom:8px;">Click the <strong>Reset My Password</strong> button below.</li>
                                  <li style="margin-bottom:8px;">Open the reset page and enter a new password.</li>
                                  <li style="margin-bottom:8px;">Confirm the password and submit the form.</li>
                                  <li>Return to the login page and sign in again.</li>
                                </ol>
                              </div>
                            </td>
                          </tr>
                          <tr>
                            <td align="center" style="padding-bottom:22px;">
                              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;">
                                <tr>
                                  <td align="center" style="border-radius:999px; background:linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); box-shadow:0 14px 30px rgba(79,70,229,0.35);">
                                    <a href="${safeResetLink}" style="display:inline-block; padding:16px 34px; font-size:16px; font-weight:800; color:#ffffff; text-decoration:none; border-radius:999px; letter-spacing:0.01em;">🔐 Reset My Password</a>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                          <tr>
                            <td style="padding-bottom:20px;">
                              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; border-collapse:collapse; background:rgba(255,255,255,0.03); border:1px solid rgba(245,158,11,0.25); border-radius:18px;">
                                <tr>
                                  <td style="padding:18px 18px 16px;">
                                    <div style="font-size:12px; letter-spacing:0.12em; text-transform:uppercase; font-weight:800; color:#fcd34d; margin-bottom:8px;">Security Notice</div>
                                    <div style="font-size:15px; line-height:1.75; color:#f8fafc;">
                                      <strong style="color:#fde68a;">⚠️ This link is strictly confidential.</strong> Do NOT share this link with anyone — not even our support team.
                                    </div>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                          <tr>
                            <td style="padding-bottom:10px;">
                              <div style="font-size:15px; line-height:1.75; color:rgba(226,232,240,0.9); margin-bottom:12px;">
                                Still facing an issue? Visit our Help Center and raise a support ticket.
                              </div>
                              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;">
                                <tr>
                                  <td align="center" style="border-radius:999px; border:1px solid rgba(167,139,250,0.28); background:rgba(255,255,255,0.02);">
                                    <a href="${safeHelpCenterUrl}" style="display:inline-block; padding:13px 24px; font-size:14px; font-weight:700; color:#ddd6fe; text-decoration:none; border-radius:999px;">Visit Help Section</a>
                                  </td>
                                </tr>
                              </table>
                              <div style="font-size:13px; line-height:1.7; color:rgba(226,232,240,0.72); margin-top:10px;">Our team will contact you within 24 hours.</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:22px 30px 28px; background:#0b1020; border-top:1px solid rgba(148,163,184,0.14);">
                        <div style="font-size:13px; line-height:1.8; color:rgba(226,232,240,0.76);">© StartInno Solutions ${yearText}</div>
                        <div style="margin-top:10px; font-size:13px; line-height:1.8; color:rgba(226,232,240,0.76);">
                          <a href="#" style="color:#c4b5fd; text-decoration:none;">Privacy Policy</a>
                          <span style="color:rgba(226,232,240,0.45);"> · </span>
                          <a href="#" style="color:#c4b5fd; text-decoration:none;">Terms of Service</a>
                          <span style="color:rgba(226,232,240,0.45);"> · </span>
                          <a href="${safeHelpCenterUrl}" style="color:#c4b5fd; text-decoration:none;">Help Center</a>
                        </div>
                        <div style="margin-top:14px; font-size:12px; line-height:1.8; color:rgba(226,232,240,0.58);">
                          You received this email because a password reset was requested for your account. If this wasn't you, please ignore this email or contact support immediately.
                        </div>
                        <div style="margin-top:10px; font-size:12px; line-height:1.8; color:rgba(226,232,240,0.58);">
                          <a href="${safeSecurityAlertUrl}" style="color:#fca5a5; text-decoration:none;">Unsubscribe / security alert</a>
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
};

const sendPasswordResetEmail = async (email, resetToken, baseUrl = 'http://localhost:5000', username = '') => {
  if (!isValidEmail(email)) {
    const error = new Error('Invalid email address');
    error.statusCode = 400;
    throw error;
  }

  const normalizedBaseUrl = normalizeFrontendBaseUrl(baseUrl || process.env.FRONTEND_URL);
  const resetLink = `${normalizedBaseUrl}/user/reset-password.html?token=${resetToken}`;
  const supportEmail = process.env.SUPPORT_EMAIL || 'askconnect4@gmail.com';
  const helpCenterUrl = process.env.HELP_CENTER_URL || `${normalizedBaseUrl}/user/help.html`;
  const securityAlertUrl = process.env.SECURITY_ALERT_URL || `mailto:${supportEmail}?subject=Security%20Alert`;
  const currentYear = new Date().getFullYear();

  const mailOptions = {
    from: getSender(),
    to: email,
    subject: 'Reset Your StartInno Solutions Password',
    html: buildPasswordResetEmailHtml({
      username,
      resetLink,
      helpCenterUrl,
      securityAlertUrl,
      currentYear
    })
  };

  return sendMail(mailOptions, { waitForDelivery: true });
};

const sendTestEmail = async (email) => {
  if (!isValidEmail(email)) {
    const error = new Error('Invalid email address');
    error.statusCode = 400;
    throw error;
  }

  return sendMail({
    from: getSender(),
    to: email,
    subject: 'StartInno Solutions test email',
    text: 'This is a test email from the StartInno Solutions mailer.'
  });
};

const sendIssueCreatedEmail = async ({ email, issueId, issueType, studentName, description, submittedDate }) => {
  if (!isValidEmail(email)) {
    const error = new Error('Invalid email address');
    error.statusCode = 400;
    throw error;
  }

  return sendMail({
    from: getSender(),
    to: email,
    subject: 'StartInno Support Ticket Created',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #f8fafc; border-radius: 12px; color: #0f172a;">
        <h2 style="margin: 0 0 16px;">Support Ticket Received</h2>
        <p style="margin: 0 0 20px; line-height: 1.6;">Thank you for contacting StartInno Solutions. We have received your issue and will review it shortly.</p>
        
        <div style="background: #fff; border: 1px solid #cbd5e1; border-radius: 10px; padding: 18px; margin: 24px 0;">
          <div style="margin-bottom: 12px;">
            <span style="font-weight: 700; color: #0f172a;">Ticket ID:</span>
            <span style="color: #2563eb; font-family: monospace;">${issueId || '—'}</span>
          </div>
          <div style="margin-bottom: 12px;">
            <span style="font-weight: 700; color: #0f172a;">Name:</span>
            <span style="color: #334155;">${studentName || '—'}</span>
          </div>
          <div style="margin-bottom: 12px;">
            <span style="font-weight: 700; color: #0f172a;">Issue Type:</span>
            <span style="color: #334155;">${issueType || '—'}</span>
          </div>
          <div style="margin-bottom: 12px;">
            <span style="font-weight: 700; color: #0f172a;">Submitted:</span>
            <span style="color: #334155;">${submittedDate ? new Date(submittedDate).toLocaleDateString() : '—'}</span>
          </div>
          <div>
            <span style="font-weight: 700; color: #0f172a;">Status:</span>
            <span style="display: inline-block; padding: 4px 8px; border-radius: 4px; background: #fee2e2; color: #dc2626; font-size: 12px; font-weight: 600;">Not Started</span>
          </div>
        </div>
        
        <div style="background: #eff6ff; border-left: 4px solid #2563eb; padding: 12px; border-radius: 4px; margin: 20px 0;">
          <p style="margin: 0; font-size: 14px; color: #1e40af;">Our StartInno Solutions team will contact you soon at the provided contact number. Thank you for your patience.</p>
        </div>
        
        <p style="margin: 20px 0 0; font-size: 12px; color: #64748b;">If you have any questions, please reply to this email or contact our support team.</p>
      </div>
    `
  });
};

const sendIssueStatusUpdateEmail = async ({ email, issueId, issueType, studentName, newStatus, updatedDate }) => {
  if (!isValidEmail(email)) {
    const error = new Error('Invalid email address');
    error.statusCode = 400;
    throw error;
  }

  const statusText = {
    'pending': 'Pending',
    'not-started': 'Not Started',
    'processing': 'Under Process',
    'resolved': 'Resolved',
    'completed': 'Completed',
    'rejected': 'Rejected'
  }[newStatus] || newStatus;

  const statusColor = {
    'pending': '#fef3c7',
    'not-started': '#fee2e2',
    'processing': '#fef3c7',
    'resolved': '#dcfce7',
    'completed': '#dcfce7',
    'rejected': '#fee2e2'
  }[newStatus] || '#f3f4f6';

  const statusTextColor = {
    'pending': '#d97706',
    'not-started': '#dc2626',
    'processing': '#d97706',
    'resolved': '#16a34a',
    'completed': '#16a34a',
    'rejected': '#dc2626'
  }[newStatus] || '#374151';

  return sendMail({
    from: getSender(),
    to: email,
    subject: 'StartInno Issue Status Updated',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #f8fafc; border-radius: 12px; color: #0f172a;">
        <h2 style="margin: 0 0 16px;">Issue Status Update</h2>
        <p style="margin: 0 0 20px; line-height: 1.6;">Your support issue status has been updated. Please see the details below.</p>
        
        <div style="background: #fff; border: 1px solid #cbd5e1; border-radius: 10px; padding: 18px; margin: 24px 0;">
          <div style="margin-bottom: 12px;">
            <span style="font-weight: 700; color: #0f172a;">Ticket ID:</span>
            <span style="color: #2563eb; font-family: monospace;">${issueId || '—'}</span>
          </div>
          <div style="margin-bottom: 12px;">
            <span style="font-weight: 700; color: #0f172a;">Name:</span>
            <span style="color: #334155;">${studentName || '—'}</span>
          </div>
          <div style="margin-bottom: 12px;">
            <span style="font-weight: 700; color: #0f172a;">Issue Type:</span>
            <span style="color: #334155;">${issueType || '—'}</span>
          </div>
          <div>
            <span style="font-weight: 700; color: #0f172a;">Updated Status:</span>
            <span style="display: inline-block; padding: 4px 8px; border-radius: 4px; background: ${statusColor}; color: ${statusTextColor}; font-size: 12px; font-weight: 600;">${statusText}</span>
          </div>
        </div>
        
        <div style="background: #eff6ff; border-left: 4px solid #2563eb; padding: 12px; border-radius: 4px; margin: 20px 0;">
          <p style="margin: 0; font-size: 14px; color: #1e40af;">We are working on resolving your issue. Thank you for your patience and support.</p>
        </div>
        
        <p style="margin: 20px 0 0; font-size: 12px; color: #64748b;">If you have any questions, please reply to this email or contact our support team.</p>
      </div>
    `
  });
};

const verifyEmailConfiguration = async () => {
  try {
    const result = await transporter.verify();
    console.log('[mailer] verification successful');
    return result;
  } catch (error) {
    console.error('[mailer] verification error:', error.message);
    return false;
  }
};

module.exports = {
  transporter,
  isValidEmail,
  verifyTransporter,
  sendMail,
  sendUsernameEmail,
  sendPasswordResetEmail,
  sendRegistrationConfirmationEmail,
  sendRegistrationSubmittedEmail,
  sendRegistrationApprovedEmail,
  sendRegistrationRejectedEmail,
  sendTestEmail,
  verifyEmailConfiguration,
  sendIssueCreatedEmail,
  sendIssueStatusUpdateEmail
};