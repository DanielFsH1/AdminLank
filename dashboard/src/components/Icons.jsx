/**
 * Sistema centralizado de iconos SVG para AdminLank
 * Reemplaza todos los emojis de la webapp con SVGs consistentes y reutilizables.
 * 
 * Uso: import { Icon } from '../components/Icons';
 *      <Icon name="lock" size={16} color="#6366f1" />
 * 
 * O directo: import { LockIcon } from '../components/Icons';
 *            <LockIcon size={16} />
 */

// ─── BASE ICON WRAPPER ───
const SvgBase = ({ size = 16, color, className = '', viewBox = '0 0 24 24', children, style, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox={viewBox}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`adminlank-icon ${className}`}
    style={{ flexShrink: 0, verticalAlign: 'middle', ...style }}
    {...props}
  >
    {children}
  </svg>
);

// Stroke-based helper
const S = ({ size = 16, color = 'currentColor', children, ...props }) => (
  <SvgBase size={size} color={color} {...props}>
    <g stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
      {children}
    </g>
  </SvgBase>
);

// ═══════════════════════════════════════════
// NAVIGATION / UI
// ═══════════════════════════════════════════

// ☰ Hamburger menu
export const MenuIcon = (p) => <S {...p}><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></S>;

// ☀ Sun (light mode)
export const SunIcon = (p) => <S {...p}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></S>;

// 🌙 Moon (dark mode)
export const MoonIcon = (p) => <S {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></S>;

// ✕ Close / X
export const CloseIcon = (p) => <S {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></S>;

// ✅ Checkmark circle (success)
export const CheckCircleIcon = ({ color = '#10b981', ...p }) => (
  <SvgBase color={color} {...p}><circle cx="12" cy="12" r="10" stroke={color} strokeWidth="2" fill="none"/><path d="M8 12l3 3 5-5" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/></SvgBase>
);

// ✓ / ✔ Check (simple)
export const CheckIcon = ({ color = 'currentColor', ...p }) => <S color={color} {...p}><polyline points="20 6 9 17 4 12"/></S>;

// ❌ X circle (error/delete)
export const XCircleIcon = ({ color = '#ef4444', ...p }) => (
  <SvgBase color={color} {...p}><circle cx="12" cy="12" r="10" stroke={color} strokeWidth="2" fill="none"/><line x1="15" y1="9" x2="9" y2="15" stroke={color} strokeWidth="2" strokeLinecap="round"/><line x1="9" y1="9" x2="15" y2="15" stroke={color} strokeWidth="2" strokeLinecap="round"/></SvgBase>
);

// ⚠ Warning triangle
export const WarningIcon = ({ color = '#f59e0b', ...p }) => (
  <SvgBase color={color} {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke={color} strokeWidth="2" fill="none"/><line x1="12" y1="9" x2="12" y2="13" stroke={color} strokeWidth="2" strokeLinecap="round"/><circle cx="12" cy="17" r="0.5" fill={color} stroke="none"/></SvgBase>
);

// ➕ Plus
export const PlusIcon = (p) => <S {...p}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></S>;

// 🔍 Search
export const SearchIcon = (p) => <S {...p}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></S>;

// 🔄 Refresh / Sync
export const RefreshIcon = (p) => <S {...p}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></S>;

// ✏ Edit / Pencil
export const EditIcon = (p) => <S {...p}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></S>;

// 💾 Save / Floppy disk
export const SaveIcon = (p) => <S {...p}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></S>;

// 🗑 Trash / Delete
export const TrashIcon = ({ color = '#ef4444', ...p }) => <S color={color} {...p}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></S>;

// 📋 Clipboard / Copy
export const ClipboardIcon = (p) => <S {...p}><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></S>;

// 🚫 Prohibited / Block
export const BlockIcon = ({ color = '#ef4444', ...p }) => <S color={color} {...p}><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></S>;


// ═══════════════════════════════════════════
// SECURITY / AUTH
// ═══════════════════════════════════════════

// 🔐 Locked with key
export const LockKeyIcon = (p) => <S {...p}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16" r="1"/></S>;

// 🔑 Key
export const KeyIcon = (p) => <S {...p}><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></S>;

// 🔒 Lock (closed)
export const LockIcon = (p) => <S {...p}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></S>;

// 🔗 Link / chain
export const LinkIcon = (p) => <S {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></S>;


// ═══════════════════════════════════════════
// PEOPLE / USERS
// ═══════════════════════════════════════════

// 👤 User (single)
export const UserIcon = (p) => <S {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></S>;

// 👥 Users (group)
export const UsersIcon = (p) => <S {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></S>;

// 👆 Point up
export const PointUpIcon = (p) => <S {...p}><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/></S>;


// ═══════════════════════════════════════════
// MONEY / FINANCE
// ═══════════════════════════════════════════

// 💰 Money bag
export const MoneyIcon = (p) => <S {...p}><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></S>;

// 💲 Dollar sign
export const DollarIcon = (p) => <S {...p}><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></S>;

// 💳 Credit card
export const CreditCardIcon = (p) => <S {...p}><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></S>;

// 💵 Bill / Cash
export const CashIcon = (p) => <S {...p}><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><line x1="6" y1="12" x2="6" y2="12.01"/><line x1="18" y1="12" x2="18" y2="12.01"/></S>;

// 💸 Money flying / expense
export const ExpenseIcon = (p) => <S {...p}><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/><path d="M18 8l3-3-3-3"/></S>;

// 📥 Deposit / Income
export const DepositIcon = p => <S {...p}><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></S>;

// 🏦 Bank
export const BankIcon = (p) => <S {...p}><path d="M3 21h18"/><path d="M3 10h18"/><path d="M5 6l7-3 7 3"/><path d="M4 10v11"/><path d="M20 10v11"/><path d="M8 14v3"/><path d="M12 14v3"/><path d="M16 14v3"/></S>;

// 🏧 ATM
export const AtmIcon = (p) => (
  <SvgBase {...p}><rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="2" fill="none"/><rect x="6" y="8" width="12" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none"/><line x1="8" y1="18" x2="10" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="14" y1="18" x2="16" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></SvgBase>
);

// 📈 Chart trending up
export const TrendUpIcon = (p) => <S {...p}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></S>;

// 📊 Bar chart
export const BarChartIcon = (p) => <S {...p}><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></S>;

// 📜 Receipt / scroll
export const ReceiptIcon = (p) => <S {...p}><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/></S>;


// ═══════════════════════════════════════════
// COMMUNICATION / MAIL
// ═══════════════════════════════════════════

// 📧 / ✉ / 📩 Email / envelope
export const EmailIcon = (p) => <S {...p}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></S>;

// 📨 Incoming mail
export const InboxIcon = (p) => <S {...p}><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></S>;

// 📬 Mailbox (with mail)
export const MailboxIcon = (p) => <S {...p}><path d="M22 17H2a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6h12z"/><path d="M6 7V3"/><path d="M10 7V5h8v10"/><rect x="14" y="3" width="6" height="4" rx="1"/></S>;

// 📭 Empty mailbox
export const EmptyMailIcon = (p) => <S {...p}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7v-2a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></S>;

// 💬 Chat / Comment
export const ChatIcon = (p) => <S {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></S>;

// 📱 Phone / Mobile
export const PhoneIcon = (p) => <S {...p}><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></S>;


// ═══════════════════════════════════════════
// NOTIFICATIONS / ALERTS
// ═══════════════════════════════════════════

// 🔔 Bell / Notification
export const BellIcon = (p) => <S {...p}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></S>;

// 🎯 Target / Goal
export const TargetIcon = (p) => <S {...p}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></S>;

// 🎉 Party / Celebration
export const CelebrationIcon = (p) => (
  <SvgBase {...p}><path d="M5.8 21.2L2 22l.8-3.8L14.4 6.6l3 3L5.8 21.2z" stroke="currentColor" strokeWidth="2" fill="none"/><path d="M18 2l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M15 5l2-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M19 9l2-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="18" cy="3" r="1" fill="currentColor"/><circle cx="22" cy="7" r="1" fill="currentColor"/><circle cx="20" cy="1" r="0.75" fill="currentColor"/></SvgBase>
);


// ═══════════════════════════════════════════
// TIME / SCHEDULE
// ═══════════════════════════════════════════

// ⏰ / 🕐 Clock / Alarm
export const ClockIcon = (p) => <S {...p}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></S>;

// ⏳ Hourglass / Loading
export const HourglassIcon = (p) => <S {...p}><path d="M5 3h14"/><path d="M5 21h14"/><path d="M7 3v4l4 5-4 5v4"/><path d="M17 3v4l-4 5 4 5v4"/></S>;

// ⏱ Stopwatch
export const StopwatchIcon = (p) => <S {...p}><circle cx="12" cy="13" r="9"/><polyline points="12 9 12 13 15 14"/><line x1="12" y1="1" x2="12" y2="4"/><line x1="10" y1="1" x2="14" y2="1"/></S>;

// 📅 Calendar
export const CalendarIcon = (p) => <S {...p}><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></S>;

// 💤 Sleep / ZZZ
export const SleepIcon = (p) => <S {...p}><path d="M8 4h8l-8 8h8"/><path d="M4 12h6l-6 6h6"/></S>;


// ═══════════════════════════════════════════
// FILES / DATA
// ═══════════════════════════════════════════

// 📁 / 📂 Folder (open)
export const FolderIcon = (p) => <S {...p}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></S>;

// 📦 Package / Box
export const PackageIcon = (p) => <S {...p}><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></S>;

// 📥 Download / Import
export const DownloadIcon = (p) => <S {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></S>;
export const UploadIcon = (p) => <S {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></S>;
export const ImageIcon = (p) => <S {...p}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></S>;

// 🗃 File cabinet / Storage
export const FileStorageIcon = (p) => <S {...p}><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></S>;

// 🗄 Server / Database
export const ServerIcon = (p) => <S {...p}><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></S>;

// 📝 Notes / Write
export const NotesIcon = (p) => <S {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></S>;


// ═══════════════════════════════════════════
// TOOLS / SETTINGS
// ═══════════════════════════════════════════

// 🔧 Wrench / Settings
export const WrenchIcon = (p) => <S {...p}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></S>;

// ⚙ Settings (gear)
export const SettingsIcon = (p) => <S {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></S>;

// Toggle on/off
export const ToggleOnIcon = (p) => <S {...p}><rect x="1" y="5" width="22" height="14" rx="7" ry="7"/><circle cx="16" cy="12" r="3"/></S>;
export const ToggleOffIcon = (p) => <S {...p}><rect x="1" y="5" width="22" height="14" rx="7" ry="7"/><circle cx="8" cy="12" r="3"/></S>;

// Sliders
export const SlidersIcon = (p) => <S {...p}><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></S>;

// 🧰 Toolbox
export const ToolboxIcon = (p) => <S {...p}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="12" x2="12" y2="16"/></S>;

// 🔬 Microscope / Analyze
export const AnalyzeIcon = (p) => <S {...p}><circle cx="11" cy="11" r="4"/><path d="M14.5 14.5L20 20"/><line x1="8" y1="16" x2="8" y2="22"/><line x1="4" y1="22" x2="12" y2="22"/><path d="M11 7V2"/><path d="M7 4l4-2 4 2"/></S>;

// 🧹 Broom / Clean
export const CleanIcon = (p) => <S {...p}><path d="M12 2v8"/><path d="M4.93 10h14.14"/><path d="M6 10l1 12h10l1-12"/><line x1="10" y1="14" x2="10" y2="18"/><line x1="14" y1="14" x2="14" y2="18"/></S>;

// 🚪 Door / Exit / Logout
export const DoorIcon = (p) => <S {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></S>;


// ═══════════════════════════════════════════
// STATUS INDICATORS
// ═══════════════════════════════════════════

// 🔴 Red dot (danger/critical)
export const DotRed = ({ size = 10, ...p }) => (
  <SvgBase size={size} viewBox="0 0 12 12" {...p}><circle cx="6" cy="6" r="5" fill="#ef4444"/></SvgBase>
);

// 🟠 Orange dot (warning)
export const DotOrange = ({ size = 10, ...p }) => (
  <SvgBase size={size} viewBox="0 0 12 12" {...p}><circle cx="6" cy="6" r="5" fill="#f97316"/></SvgBase>
);

// 🟡 Yellow dot (caution)
export const DotYellow = ({ size = 10, ...p }) => (
  <SvgBase size={size} viewBox="0 0 12 12" {...p}><circle cx="6" cy="6" r="5" fill="#eab308"/></SvgBase>
);

// 🟢 Green dot (active/success)
export const DotGreen = ({ size = 10, ...p }) => (
  <SvgBase size={size} viewBox="0 0 12 12" {...p}><circle cx="6" cy="6" r="5" fill="#22c55e"/></SvgBase>
);

// 🔵 Blue dot (info)
export const DotBlue = ({ size = 10, ...p }) => (
  <SvgBase size={size} viewBox="0 0 12 12" {...p}><circle cx="6" cy="6" r="5" fill="#3b82f6"/></SvgBase>
);

// ⚪ White/gray dot (inactive)
export const DotGray = ({ size = 10, ...p }) => (
  <SvgBase size={size} viewBox="0 0 12 12" {...p}><circle cx="6" cy="6" r="5" fill="#9ca3af" stroke="#d1d5db" strokeWidth="1"/></SvgBase>
);

// ☐ Checkbox unchecked
export const CheckboxEmpty = (p) => <S {...p}><rect x="3" y="3" width="18" height="18" rx="2"/></S>;

// ☑ Checkbox checked
export const CheckboxChecked = ({ color = '#10b981', ...p }) => (
  <SvgBase {...p}><rect x="3" y="3" width="18" height="18" rx="2" stroke={color} strokeWidth="2" fill="none"/><path d="M8 12l3 3 5-5" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/></SvgBase>
);


// ═══════════════════════════════════════════
// MISC / SPECIALTY
// ═══════════════════════════════════════════

// 📡 Satellite / API / Live
export const SatelliteIcon = (p) => <S {...p}><path d="M2 20h20"/><path d="M5 20v-4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/><circle cx="12" cy="4" r="2"/><path d="M12 6v8"/></S>;

// ⚡ Lightning / Power
export const LightningIcon = ({ color = '#eab308', ...p }) => (
  <SvgBase {...p}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round"/></SvgBase>
);

// 💡 Lightbulb / Idea
export const LightbulbIcon = (p) => <S {...p}><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 1 4 12.7V17H8v-2.3A7 7 0 0 1 12 2z"/></S>;

// 🌐 Globe / Internet
export const GlobeIcon = (p) => <S {...p}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></S>;

// 🏗 Construction / Build
export const BuildIcon = (p) => <S {...p}><path d="M2 20h20"/><path d="M6 20V8l6-4 6 4v12"/><path d="M10 12h4"/><path d="M10 16h4"/></S>;

// 📌 / 📍 Pin / Location
export const PinIcon = (p) => <S {...p}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></S>;

// 📌 Thumbtack / Fijar
export const ThumbtackIcon = (p) => <S {...p}><path d="M9 4v6l-2 4v2h10v-2l-2-4V4"/><line x1="12" y1="16" x2="12" y2="21"/><line x1="8" y1="4" x2="16" y2="4"/></S>;

// 📝 Notepad / Bloc de notas
export const NotepadIcon = (p) => <S {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></S>;

// 📛 Name badge
export const BadgeIcon = (p) => <S {...p}><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="7" y1="10" x2="17" y2="10"/><line x1="7" y1="14" x2="13" y2="14"/></S>;

// 🌱 Seedling / Grow
export const SeedlingIcon = ({ color = '#22c55e', ...p }) => <S color={color} {...p}><path d="M12 22v-8"/><path d="M7 14c0-4.418 2.239-8 5-8s5 3.582 5 8"/><path d="M5 8c2-2 4-2.5 7-2"/><path d="M19 8c-2-2-4-2.5-7-2"/></S>;

// 🌤 Partly cloudy / Daytime
export const CloudSunIcon = (p) => <S {...p}><path d="M12 2v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M20 12h2"/><path d="M17.66 6.34l1.41-1.41"/><path d="M6.34 17.66l-1.41 1.41"/><circle cx="12" cy="10" r="4"/><path d="M8 16a5 5 0 0 0 10 0H8z"/></S>;

// 🔢 Numbers / Hash
export const HashIcon = (p) => <S {...p}><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></S>;

// ✨ Sparkle / AI / Star
export const SparkleIcon = (p) => <S {...p}><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></S>;

// 🤖 Bot / Robot
export const BotIcon = (p) => <S {...p}><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></S>;

// 📦 Container / Docker artifacts
export const ContainerIcon = (p) => <S {...p}><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></S>;

// 🛡 Shield check / Policy
export const ShieldCheckIcon = (p) => <S {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></S>;

// ═══════════════════════════════════════════
// ICON MAP - Acceso dinámico por nombre
// ═══════════════════════════════════════════

export const ICON_MAP = {
  // Navigation / UI
  menu: MenuIcon, sun: SunIcon, moon: MoonIcon, close: CloseIcon,
  checkCircle: CheckCircleIcon, check: CheckIcon, xCircle: XCircleIcon,
  warning: WarningIcon, plus: PlusIcon, search: SearchIcon,
  refresh: RefreshIcon, edit: EditIcon, save: SaveIcon, trash: TrashIcon,
  clipboard: ClipboardIcon, block: BlockIcon,
  // Security
  lockKey: LockKeyIcon, key: KeyIcon, lock: LockIcon, link: LinkIcon,
  // People
  user: UserIcon, users: UsersIcon, pointUp: PointUpIcon,
  // Money
  money: MoneyIcon, dollar: DollarIcon, creditCard: CreditCardIcon,
  cash: CashIcon, expense: ExpenseIcon, deposit: DepositIcon, bank: BankIcon, atm: AtmIcon,
  trendUp: TrendUpIcon, barChart: BarChartIcon, receipt: ReceiptIcon,
  // Communication
  email: EmailIcon, inbox: InboxIcon, mailbox: MailboxIcon,
  emptyMail: EmptyMailIcon, chat: ChatIcon, phone: PhoneIcon,
  // Notifications
  bell: BellIcon, target: TargetIcon, celebration: CelebrationIcon,
  // Time
  clock: ClockIcon, hourglass: HourglassIcon, stopwatch: StopwatchIcon,
  calendar: CalendarIcon, sleep: SleepIcon,
  // Files
  folder: FolderIcon, package: PackageIcon, download: DownloadIcon,
  fileStorage: FileStorageIcon, server: ServerIcon, notes: NotesIcon,
  // Tools
  wrench: WrenchIcon, toolbox: ToolboxIcon, analyze: AnalyzeIcon,
  clean: CleanIcon, door: DoorIcon,
  // Status
  dotRed: DotRed, dotOrange: DotOrange, dotYellow: DotYellow,
  dotGreen: DotGreen, dotBlue: DotBlue, dotGray: DotGray,
  checkboxEmpty: CheckboxEmpty, checkboxChecked: CheckboxChecked,
  // Misc
  satellite: SatelliteIcon, lightning: LightningIcon, lightbulb: LightbulbIcon,
  globe: GlobeIcon, build: BuildIcon, pin: PinIcon, badge: BadgeIcon,
  seedling: SeedlingIcon, cloudSun: CloudSunIcon, hash: HashIcon,
  sparkle: SparkleIcon, bot: BotIcon, container: ContainerIcon,
  shieldCheck: ShieldCheckIcon,
};

// Componente genérico para acceso por nombre
export const Icon = ({ name, ...props }) => {
  const IconComponent = ICON_MAP[name];
  if (!IconComponent) {
    console.warn(`Icon "${name}" not found in ICON_MAP`);
    return null;
  }
  return <IconComponent {...props} />;
};

export default Icon;
