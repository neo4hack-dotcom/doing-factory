// DOINg.AI Factory design system: hand-rolled primitives on Tailwind (no component library), in the
// DOINg family look — brand green Pantone 340 C #009464, zinc (light) / ink (dark) neutrals, uppercase micro-labels,
// 1px borders, rounded-lg/xl. Every feature view composes these; API reference: src/README-frontend.md.
import {
  AlertTriangle, Check, CheckCircle2, Copy, Info, Loader2, ShieldAlert, X, XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import type { ComponentProps, KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { errorMessage } from '../api';
import { cls } from '../lib/cls';
import { initials } from '../lib/format';
import { statusMeta } from '../lib/status';
import type { StatusKind } from '../lib/status';
import type { Tone, User } from '../types';
import { Sparkline } from './Charts';

export { cls };

// =============================================================================================
// Tones — static class strings (Tailwind only ships classes it can see written in full)
// =============================================================================================

interface ToneClasses {
  soft: string;      // tinted chip background + text
  solid: string;     // filled background, white text
  text: string;      // coloured text
  dot: string;       // small filled dot / bar
  icon: string;      // tinted icon tile
  border: string;    // accent border
  ring: string;      // focus/selection ring
}

export const TONE: Record<Tone, ToneClasses> = {
  zinc: {
    soft: 'bg-zinc-100 text-zinc-700 ring-zinc-500/15 dark:bg-ink-600 dark:text-zinc-300 dark:ring-white/10',
    solid: 'bg-zinc-600 text-white dark:bg-ink-400',
    text: 'text-zinc-600 dark:text-zinc-400',
    dot: 'bg-zinc-400 dark:bg-zinc-500',
    icon: 'bg-zinc-100 text-zinc-600 dark:bg-ink-600 dark:text-zinc-300',
    border: 'border-zinc-300 dark:border-ink-400',
    ring: 'ring-zinc-400/40',
  },
  brand: {
    soft: 'bg-brand-50 text-brand-700 ring-brand-600/20 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-400/25',
    solid: 'bg-brand-500 text-white',
    text: 'text-brand-600 dark:text-brand-400',
    dot: 'bg-brand-500',
    icon: 'bg-brand-500/10 text-brand-600 dark:text-brand-400',
    border: 'border-brand-500',
    ring: 'ring-brand-500/40',
  },
  emerald: {
    soft: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20',
    solid: 'bg-emerald-600 text-white',
    text: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    icon: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    border: 'border-emerald-500',
    ring: 'ring-emerald-500/40',
  },
  sky: {
    soft: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/20',
    solid: 'bg-sky-600 text-white',
    text: 'text-sky-600 dark:text-sky-400',
    dot: 'bg-sky-500',
    icon: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
    border: 'border-sky-500',
    ring: 'ring-sky-500/40',
  },
  amber: {
    soft: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20',
    solid: 'bg-amber-500 text-white',
    text: 'text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
    icon: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    border: 'border-amber-500',
    ring: 'ring-amber-500/40',
  },
  rose: {
    soft: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/20',
    solid: 'bg-rose-600 text-white',
    text: 'text-rose-600 dark:text-rose-400',
    dot: 'bg-rose-500',
    icon: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
    border: 'border-rose-500',
    ring: 'ring-rose-500/40',
  },
  violet: {
    soft: 'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/20',
    solid: 'bg-violet-600 text-white',
    text: 'text-violet-600 dark:text-violet-400',
    dot: 'bg-violet-500',
    icon: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
    border: 'border-violet-500',
    ring: 'ring-violet-500/40',
  },
  indigo: {
    soft: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-400/20',
    solid: 'bg-indigo-600 text-white',
    text: 'text-indigo-600 dark:text-indigo-400',
    dot: 'bg-indigo-500',
    icon: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
    border: 'border-indigo-500',
    ring: 'ring-indigo-500/40',
  },
  cyan: {
    soft: 'bg-cyan-50 text-cyan-700 ring-cyan-600/20 dark:bg-cyan-500/10 dark:text-cyan-300 dark:ring-cyan-400/20',
    solid: 'bg-cyan-600 text-white',
    text: 'text-cyan-600 dark:text-cyan-400',
    dot: 'bg-cyan-500',
    icon: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
    border: 'border-cyan-500',
    ring: 'ring-cyan-500/40',
  },
  fuchsia: {
    soft: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-600/20 dark:bg-fuchsia-500/10 dark:text-fuchsia-300 dark:ring-fuchsia-400/20',
    solid: 'bg-fuchsia-600 text-white',
    text: 'text-fuchsia-600 dark:text-fuchsia-400',
    dot: 'bg-fuchsia-500',
    icon: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400',
    border: 'border-fuchsia-500',
    ring: 'ring-fuchsia-500/40',
  },
  pink: {
    soft: 'bg-pink-50 text-pink-700 ring-pink-600/20 dark:bg-pink-500/10 dark:text-pink-300 dark:ring-pink-400/20',
    solid: 'bg-pink-600 text-white',
    text: 'text-pink-600 dark:text-pink-400',
    dot: 'bg-pink-500',
    icon: 'bg-pink-500/10 text-pink-600 dark:text-pink-400',
    border: 'border-pink-500',
    ring: 'ring-pink-500/40',
  },
  orange: {
    soft: 'bg-orange-50 text-orange-700 ring-orange-600/20 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-400/20',
    solid: 'bg-orange-600 text-white',
    text: 'text-orange-600 dark:text-orange-400',
    dot: 'bg-orange-500',
    icon: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
    border: 'border-orange-500',
    ring: 'ring-orange-500/40',
  },
  teal: {
    soft: 'bg-teal-50 text-teal-700 ring-teal-600/20 dark:bg-teal-500/10 dark:text-teal-300 dark:ring-teal-400/20',
    solid: 'bg-teal-600 text-white',
    text: 'text-teal-600 dark:text-teal-400',
    dot: 'bg-teal-500',
    icon: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
    border: 'border-teal-500',
    ring: 'ring-teal-500/40',
  },
};

const TONE_NAMES = Object.keys(TONE) as Tone[];
const ALIASES: Record<string, Tone> = {
  gray: 'zinc', grey: 'zinc', slate: 'zinc', neutral: 'zinc', stone: 'zinc',
  green: 'emerald', lime: 'emerald', blue: 'sky', red: 'rose', yellow: 'amber', purple: 'violet',
};

/** Maps any colour name found in data (stage colour, role colour, 'green'…) to a Tone. */
export function toneOf(color: string | null | undefined): Tone {
  const c = (color ?? '').toLowerCase().trim();
  if ((TONE_NAMES as string[]).includes(c)) return c as Tone;
  return ALIASES[c] ?? 'zinc';
}

/** Stable tone for a name (avatars, tags) — the same person is always the same colour. */
export function toneForName(name: string): Tone {
  const palette: Tone[] = ['brand', 'sky', 'emerald', 'violet', 'amber', 'cyan', 'fuchsia', 'teal', 'pink', 'indigo'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

// =============================================================================================
// Layers: Esc closes only the topmost overlay (a confirm inside a drawer must not close both)
// =============================================================================================

const layerStack: number[] = [];
let layerSeq = 0;

/** While `active`, Escape calls `onEscape` — but only if this is the topmost open layer. */
export function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const id = ++layerSeq;
    layerStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || layerStack[layerStack.length - 1] !== id) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      layerStack.splice(layerStack.indexOf(id), 1);
    };
  }, [active]);
}

function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

// =============================================================================================
// Buttons
// =============================================================================================

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'ai';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-brand-500 text-white shadow-sm shadow-brand-500/20 hover:bg-brand-600 active:bg-brand-700',
  outline:
    'border border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400 hover:bg-zinc-50 ' +
    'dark:border-ink-400 dark:bg-transparent dark:text-zinc-200 dark:hover:border-zinc-500 dark:hover:bg-ink-600',
  ghost: 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-ink-600 dark:hover:text-white',
  danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-700 active:bg-rose-800',
  ai: 'btn-ai',
};

const BTN_SIZE: Record<ButtonSize, { box: string; icon: number }> = {
  xs: { box: 'h-7 gap-1 rounded-md px-2 text-xs', icon: 12 },
  sm: { box: 'h-8 gap-1.5 rounded-lg px-2.5 text-xs', icon: 14 },
  md: { box: 'h-9 gap-2 rounded-lg px-3.5 text-sm', icon: 16 },
  lg: { box: 'h-11 gap-2 rounded-xl px-5 text-sm', icon: 17 },
};

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  /** Icon after the label (e.g. ArrowRight). */
  iconRight?: LucideIcon;
  /** Shows a spinner and disables the button. */
  busy?: boolean;
}

export function Button({
  variant = 'primary', size = 'md', icon: Icon, iconRight: IconRight, busy, className, children, disabled,
  type = 'button', ...rest
}: ButtonProps) {
  const s = BTN_SIZE[size];
  return (
    <button
      type={type}
      className={cls(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-semibold transition-all',
        'disabled:cursor-not-allowed disabled:opacity-55',
        s.box, BTN_VARIANT[variant], className,
      )}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Loader2 size={s.icon} className="animate-spin" /> : Icon ? <Icon size={s.icon} /> : null}
      {children}
      {IconRight && !busy && <IconRight size={s.icon} />}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: LucideIcon;
  /** Accessible name, also shown as the native tooltip. Required: an icon alone says nothing to a screen reader. */
  label: string;
  variant?: 'ghost' | 'outline' | 'primary';
  size?: 'xs' | 'sm' | 'md';
  /** Pressed/selected look (toggles, open menus). */
  active?: boolean;
  /** Small count bubble in the corner (99+ cap); 0 hides it. */
  badge?: number;
  busy?: boolean;
}

const ICON_BTN_SIZE = { xs: { box: 'h-6 w-6 rounded-md', icon: 13 }, sm: { box: 'h-8 w-8 rounded-lg', icon: 15 }, md: { box: 'h-9 w-9 rounded-lg', icon: 17 } };

export function IconButton({
  icon: Icon, label, variant = 'ghost', size = 'sm', active, badge, busy, className, disabled, type = 'button', ...rest
}: IconButtonProps) {
  const s = ICON_BTN_SIZE[size];
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active ?? undefined}
      disabled={disabled || busy}
      className={cls(
        'relative inline-flex shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        s.box,
        variant === 'primary' ? BTN_VARIANT.primary : variant === 'outline' ? BTN_VARIANT.outline : BTN_VARIANT.ghost,
        active && 'bg-zinc-100 text-zinc-900 dark:bg-ink-600 dark:text-white',
        className,
      )}
      {...rest}
    >
      {busy ? <Loader2 size={s.icon} className="animate-spin" /> : <Icon size={s.icon} />}
      {!!badge && badge > 0 && (
        <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[9px] font-bold leading-none text-white ring-2 ring-white dark:ring-ink-900">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

/** Copies `text` to the clipboard with a transient "Copied" state. */
export function CopyButton({ text, label = 'Copy', size = 'sm', variant = 'ghost', className }: {
  text: string; label?: string; size?: ButtonSize; variant?: ButtonVariant; className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('The browser blocked clipboard access — select the text and copy it manually.');
    }
  };
  return (
    <Button variant={variant} size={size} icon={copied ? Check : Copy} onClick={copy} className={className}>
      {copied ? 'Copied' : label}
    </Button>
  );
}

// =============================================================================================
// Surfaces
// =============================================================================================

export type CardTone = 'default' | 'accent' | 'ai' | 'muted';

const CARD_TONE: Record<CardTone, string> = {
  default: 'card',
  accent: 'rounded-xl border border-brand-500/30 bg-brand-50/50 dark:border-brand-500/30 dark:bg-brand-500/5',
  ai: 'card ring-ai',
  muted: 'rounded-xl border surface-deep',
};

const CARD_PAD = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-6' };

export interface CardProps extends Omit<ComponentProps<'div'>, 'onClick'> {
  tone?: CardTone;
  padding?: keyof typeof CARD_PAD;
  /** Makes the whole card clickable (keyboard: Enter/Space) with a hover border. */
  onClick?: () => void;
}

export function Card({ tone = 'default', padding = 'md', onClick, className, children, ...rest }: CardProps) {
  const interactive = !!onClick;
  return (
    <div
      className={cls(
        CARD_TONE[tone], CARD_PAD[padding],
        interactive && 'cursor-pointer transition-colors hover:border-brand-500/60 dark:hover:border-brand-500/50',
        className,
      )}
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e: ReactKeyboardEvent) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          onClick();
        }
      } : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, eyebrow, icon: Icon, iconTone = 'brand', actions, className, divider = true }: {
  title: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  icon?: LucideIcon;
  iconTone?: Tone;
  actions?: ReactNode;
  className?: string;
  /** Bottom border separating the header from a padded body (default true). */
  divider?: boolean;
}) {
  return (
    <div className={cls('flex items-start justify-between gap-3 px-4 py-3', divider && 'border-b hairline', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <span className={cls('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg', TONE[iconTone].icon)}>
            <Icon size={16} />
          </span>
        )}
        <div className="min-w-0">
          {eyebrow && <div className="label-xs mb-0.5">{eyebrow}</div>}
          <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/** Page or section heading: uppercase eyebrow, bold tight title, muted description, actions right. */
export function SectionHeader({ eyebrow, title, description, actions, icon: Icon, size = 'page', className }: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  size?: 'page' | 'section';
  className?: string;
}) {
  return (
    <div className={cls('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', size === 'page' ? 'mb-6' : 'mb-3', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <div className={cls('label-xs flex items-center gap-1.5', size === 'page' ? 'mb-1.5' : 'mb-1')}>
            {Icon && <Icon size={12} className="text-brand-500" />}
            {eyebrow}
          </div>
        )}
        <h1 className={cls(
          'font-bold tracking-tight text-zinc-900 dark:text-white',
          size === 'page' ? 'text-2xl sm:text-[1.7rem] sm:leading-tight' : 'text-base',
        )}>
          {title}
        </h1>
        {description && (
          <p className={cls('max-w-2xl text-muted', size === 'page' ? 'mt-1.5 text-sm' : 'mt-0.5 text-xs')}>{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// =============================================================================================
// Badges & avatars
// =============================================================================================

export function Badge({ tone = 'zinc', variant = 'soft', icon: Icon, dot, size = 'sm', title, className, children }: {
  tone?: Tone;
  variant?: 'soft' | 'solid' | 'outline';
  icon?: LucideIcon;
  /** Leading coloured dot (status-style chip). */
  dot?: boolean;
  size?: 'xs' | 'sm';
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <span
      title={title}
      className={cls(
        'inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-md font-semibold',
        size === 'xs' ? 'px-1.5 py-px text-[10px]' : 'px-1.5 py-0.5 text-[11px]',
        variant === 'soft' && cls(t.soft, 'ring-1 ring-inset'),
        variant === 'solid' && t.solid,
        variant === 'outline' && cls('border bg-transparent', t.border, t.text),
        className,
      )}
    >
      {dot && <span className={cls('h-1.5 w-1.5 shrink-0 rounded-full', variant === 'solid' ? 'bg-white/80' : t.dot)} />}
      {Icon && <Icon size={size === 'xs' ? 10 : 12} className="shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * Coloured chip for a status-like value: <StatusBadge kind="step" value={step.status} />.
 * Kinds: step, project, stage, priority, risk, severity, check, intake (vocabularies in lib/status.ts).
 * A running step pulses so live work is visible at a glance.
 */
export function StatusBadge({ kind, value, size = 'sm', className }: {
  kind: StatusKind; value: string; size?: 'xs' | 'sm'; className?: string;
}) {
  const meta = statusMeta(kind, value);
  const running = kind === 'step' && value === 'running';
  return (
    <span
      className={cls(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-semibold ring-1 ring-inset',
        size === 'xs' ? 'px-1.5 py-px text-[10px]' : 'px-1.5 py-0.5 text-[11px]',
        TONE[meta.tone].soft, className,
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        {running && <span className={cls('absolute inline-flex h-full w-full animate-ping rounded-full opacity-75', TONE[meta.tone].dot)} />}
        <span className={cls('relative inline-flex h-1.5 w-1.5 rounded-full', TONE[meta.tone].dot)} />
      </span>
      {meta.label}
    </span>
  );
}

type AvatarUser = Pick<User, 'name'> & Partial<Pick<User, 'id' | 'avatar_color' | 'title'>>;

/** Initials avatar. `avatar_color` may be a hex ("#009464") or a tone name; '' = derived from the name. */
export function Avatar({ user, name, size = 28, className, title }: {
  user?: AvatarUser | null;
  name?: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const label = user?.name || name || '?';
  const color = user?.avatar_color ?? '';
  const isHex = /^#[0-9a-f]{3,8}$/i.test(color);
  const tone = color && !isHex ? toneOf(color) : toneForName(label);
  return (
    <span
      title={title ?? label}
      className={cls(
        'inline-grid shrink-0 select-none place-items-center rounded-full font-bold uppercase leading-none',
        !isHex && TONE[tone].solid,
        isHex && 'text-white',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.38), ...(isHex ? { backgroundColor: color } : {}) }}
    >
      {label === '?' ? '?' : initials(label)}
    </span>
  );
}

/** Overlapping avatars ("who must approve"), with a +N overflow chip. */
export function AvatarStack({ users, max = 4, size = 24, className }: {
  users: Array<AvatarUser | null | undefined>;
  max?: number;
  size?: number;
  className?: string;
}) {
  const list = users.filter((u): u is AvatarUser => !!u);
  const shown = list.slice(0, max);
  const extra = list.length - shown.length;
  return (
    <div className={cls('flex items-center -space-x-1.5', className)}>
      {shown.map((u, i) => (
        <Avatar key={u.id ?? `${u.name}-${i}`} user={u} size={size} className="ring-2 ring-white dark:ring-ink-800" />
      ))}
      {extra > 0 && (
        <span
          title={list.slice(max).map((u) => u.name).join(', ')}
          className="inline-grid shrink-0 place-items-center rounded-full bg-zinc-200 font-bold text-zinc-600 ring-2 ring-white dark:bg-ink-500 dark:text-zinc-300 dark:ring-ink-800"
          style={{ width: size, height: size, fontSize: Math.max(9, size * 0.34) }}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

// =============================================================================================
// Form controls
// =============================================================================================

const INPUT_BASE =
  'w-full rounded-lg border bg-white text-sm text-zinc-900 placeholder:text-zinc-400 outline-none transition-colors ' +
  'focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:cursor-not-allowed disabled:opacity-60 ' +
  'dark:bg-ink-900 dark:text-zinc-100 dark:placeholder:text-zinc-500';
const INPUT_BORDER = 'border-zinc-300 dark:border-ink-500';
const INPUT_INVALID = 'border-rose-500 focus:border-rose-500 focus:ring-rose-500/20 dark:border-rose-500';

/** Label + control + help/error. Pass `htmlFor` to link the label to a control with that id. */
export function Field({ label, help, error, required, htmlFor, aside, className, children }: {
  label?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  /** Right side of the label row (AI button, counter…). */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cls('min-w-0', className)}>
      {(label || aside) && (
        <div className="mb-1.5 flex min-h-5 items-center justify-between gap-2">
          {label && (
            <label htmlFor={htmlFor} className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              {label}
              {required && <span className="ml-0.5 text-brand-500" aria-hidden>*</span>}
            </label>
          )}
          {aside && <div className="flex shrink-0 items-center gap-1">{aside}</div>}
        </div>
      )}
      {children}
      {error ? (
        <p className="mt-1 text-[11px] font-medium text-rose-600 dark:text-rose-400" role="alert">{error}</p>
      ) : help ? (
        <p className="mt-1 text-[11px] text-faint">{help}</p>
      ) : null}
    </div>
  );
}

export interface InputProps extends ComponentProps<'input'> {
  invalid?: boolean;
  /** Leading icon inside the field (search boxes). */
  icon?: LucideIcon;
}

export function Input({ invalid, icon: Icon, className, ...rest }: InputProps) {
  const input = (
    <input
      className={cls(INPUT_BASE, 'h-9 px-3', Icon && 'pl-8', invalid ? INPUT_INVALID : INPUT_BORDER, !Icon && className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
  if (!Icon) return input;
  return (
    <div className={cls('relative', className)}>
      <Icon size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
      {input}
    </div>
  );
}

export interface TextareaProps extends ComponentProps<'textarea'> {
  invalid?: boolean;
  /** Grow with the content (default true) between minRows and maxRows. */
  autoGrow?: boolean;
  minRows?: number;
  maxRows?: number;
}

export function Textarea({ invalid, autoGrow = true, minRows = 3, maxRows = 18, className, ref, ...rest }: TextareaProps) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || !autoGrow) return;
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || 20;
    const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = 'auto';
    const target = Math.min(Math.max(el.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth), minRows * line + chrome), maxRows * line + chrome);
    el.style.height = `${target}px`;
    el.style.overflowY = el.scrollHeight + 2 > target ? 'auto' : 'hidden';
  }, [rest.value, autoGrow, minRows, maxRows]);
  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        assignRef(ref, el);
      }}
      rows={minRows}
      className={cls(INPUT_BASE, 'px-3 py-2 leading-relaxed', autoGrow ? 'resize-none' : 'resize-y', invalid ? INPUT_INVALID : INPUT_BORDER, className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export type SelectOption = string | { value: string; label: string; disabled?: boolean };

export interface SelectProps extends ComponentProps<'select'> {
  options?: SelectOption[];
  /** First, empty option (value ''), e.g. "Select a team…". */
  placeholder?: string;
  invalid?: boolean;
}

export function Select({ options, placeholder, invalid, className, children, ...rest }: SelectProps) {
  return (
    <select
      className={cls(INPUT_BASE, 'h-9 cursor-pointer pl-3 pr-8', invalid ? INPUT_INVALID : INPUT_BORDER, className)}
      aria-invalid={invalid || undefined}
      {...rest}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options?.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>;
      })}
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label, description, disabled, size = 'md', className }: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const track = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9';
  const knob = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  const on = size === 'sm' ? 'translate-x-3' : 'translate-x-4';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cls('group inline-flex items-start gap-2.5 text-left disabled:cursor-not-allowed disabled:opacity-55', className)}
    >
      <span className={cls('relative mt-0.5 inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors', track,
        checked ? 'bg-brand-500' : 'bg-zinc-300 dark:bg-ink-400')}>
        <span className={cls('rounded-full bg-white shadow-sm transition-transform', knob, checked && on)} />
      </span>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</span>}
          {description && <span className="block text-xs text-muted">{description}</span>}
        </span>
      )}
    </button>
  );
}

export function Checkbox({ checked, onChange, label, description, disabled, className }: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cls('flex items-start gap-2.5', disabled && 'opacity-55', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-zinc-300 accent-brand-500 disabled:cursor-not-allowed dark:border-ink-400"
      />
      {(label || description) && (
        <label htmlFor={id} className="min-w-0 cursor-pointer">
          {label && <span className="block text-sm text-zinc-800 dark:text-zinc-200">{label}</span>}
          {description && <span className="block text-xs text-muted">{description}</span>}
        </label>
      )}
    </div>
  );
}

// =============================================================================================
// Navigation: tabs
// =============================================================================================

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
  icon?: LucideIcon;
  /** Count chip after the label (hidden when undefined). */
  count?: number;
  disabled?: boolean;
}

/** Underline tabs (uppercase micro-label style). Arrow keys move between tabs. */
export function Tabs<K extends string>({ tabs, value, onChange, className, size = 'md' }: {
  tabs: TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const move = (dir: 1 | -1) => {
    const enabled = tabs.filter((t) => !t.disabled);
    const i = enabled.findIndex((t) => t.key === value);
    const next = enabled[(i + dir + enabled.length) % enabled.length];
    if (next) onChange(next.key);
  };
  return (
    <div
      role="tablist"
      className={cls('no-scrollbar flex gap-1 overflow-x-auto border-b hairline', className)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') move(1);
        if (e.key === 'ArrowLeft') move(-1);
      }}
    >
      {tabs.map(({ key, label, icon: Icon, count, disabled }) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(key)}
            className={cls(
              '-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 font-bold uppercase tracking-[0.12em] transition-colors disabled:opacity-40',
              size === 'sm' ? 'px-2.5 py-2 text-[10px]' : 'px-3 py-2.5 text-[11px]',
              active
                ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                : 'border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800 dark:text-zinc-400 dark:hover:border-ink-400 dark:hover:text-zinc-200',
            )}
          >
            {Icon && <Icon size={13} />}
            {label}
            {count !== undefined && (
              <span className={cls('num rounded px-1 py-px text-[10px] tracking-normal',
                active ? 'bg-brand-500/10' : 'bg-zinc-100 dark:bg-ink-600')}>{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================================
// Overlays: modal, drawer, popover, tooltip
// =============================================================================================

const MODAL_SIZE = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' };

export function Modal({ open, onClose, title, subtitle, icon: Icon, iconTone = 'brand', footer, size = 'md', className, children }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  iconTone?: Tone;
  footer?: ReactNode;
  size?: keyof typeof MODAL_SIZE;
  className?: string;
  children: ReactNode;
}) {
  useEscapeLayer(open, onClose);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    // Focus the first field if any (forms open ready to type), else the panel itself.
    const first = panel.current?.querySelector<HTMLElement>('input, textarea, select');
    (first ?? panel.current)?.focus();
    return () => previous?.focus?.();
  }, [open]);
  if (!open) return null;
  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/50 p-4 pt-[8vh] backdrop-blur-sm animate-fade-in" onMouseDown={onClose}>
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          onMouseDown={(e) => e.stopPropagation()}
          className={cls('card flex max-h-[84vh] w-full flex-col overflow-hidden shadow-pop outline-none animate-scale-in', MODAL_SIZE[size], className)}
        >
          <div className="flex items-start justify-between gap-3 border-b hairline px-5 py-4">
            <div className="flex min-w-0 items-start gap-3">
              {Icon && (
                <span className={cls('grid h-9 w-9 shrink-0 place-items-center rounded-lg', TONE[iconTone].icon)}>
                  <Icon size={18} />
                </span>
              )}
              <div className="min-w-0">
                <h2 className="text-base font-bold tracking-tight text-zinc-900 dark:text-white">{title}</h2>
                {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
              </div>
            </div>
            <IconButton icon={X} label="Close" size="sm" onClick={onClose} className="-mr-1.5 -mt-1" />
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t hairline bg-zinc-50/60 px-5 py-3 dark:bg-ink-900/40">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}

const DRAWER_WIDTH = { md: 'max-w-md', lg: 'max-w-xl', xl: 'max-w-3xl' };

/** Right-hand side panel (task panel, copilot, details). Esc / backdrop click closes. */
export function Drawer({ open, onClose, title, subtitle, icon: Icon, actions, footer, width = 'lg', className, children }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  /** Buttons in the header, left of the close button. */
  actions?: ReactNode;
  footer?: ReactNode;
  width?: keyof typeof DRAWER_WIDTH;
  className?: string;
  children: ReactNode;
}) {
  useEscapeLayer(open, onClose);
  if (!open) return null;
  return (
    <Portal>
      <div className="fixed inset-0 z-40 flex justify-end bg-ink-950/30 backdrop-blur-[2px] animate-fade-in" onMouseDown={onClose}>
        <aside
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => e.stopPropagation()}
          className={cls('flex h-full w-full flex-col border-l bg-white shadow-pop animate-slide-in-right dark:border-ink-600 dark:bg-ink-900', DRAWER_WIDTH[width], className)}
        >
          <div className="flex items-start justify-between gap-3 border-b hairline px-5 py-3.5">
            <div className="flex min-w-0 items-start gap-2.5">
              {Icon && <Icon size={18} className="mt-0.5 shrink-0 text-brand-500" />}
              <div className="min-w-0">
                <h2 className="truncate text-sm font-bold text-zinc-900 dark:text-white">{title}</h2>
                {subtitle && <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p>}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {actions}
              <IconButton icon={X} label="Close" onClick={onClose} />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t hairline px-5 py-3">{footer}</div>}
        </aside>
      </div>
    </Portal>
  );
}

/**
 * Floating panel anchored to an element (menus, dropdowns). Rendered in a portal with fixed
 * positioning so overflow-hidden ancestors never clip it. Click outside or Esc closes.
 */
export function Popover({ anchor, open, onClose, align = 'left', side = 'bottom', width = 260, className, children }: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
  side?: 'bottom' | 'top';
  width?: number;
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // `edge` is the anchor's top (opening upward) or bottom (opening downward) in viewport px.
  const [pos, setPos] = useState<{ edge: number; left: number; maxHeight: number; up: boolean } | null>(null);
  useEscapeLayer(open, onClose);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const gap = 6;
      const left = Math.min(Math.max(8, align === 'right' ? r.right - width : r.left), window.innerWidth - width - 8);
      const below = window.innerHeight - r.bottom - gap - 8;
      const above = r.top - gap - 8;
      const up = side === 'top' ? above > 160 || above > below : below < 200 && above > below;
      setPos(up
        ? { edge: Math.max(8, r.top - gap), left, maxHeight: above, up }
        : { edge: r.bottom + gap, left, maxHeight: below, up });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, align, side, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose, anchor]);

  if (!open || !pos) return null;
  return (
    <Portal>
      <div
        ref={panel}
        className={cls('card fixed z-[60] overflow-y-auto p-1 shadow-pop animate-fade-in', className)}
        style={{
          left: pos.left, width, maxHeight: Math.max(160, pos.maxHeight),
          ...(pos.up ? { bottom: window.innerHeight - pos.edge } : { top: pos.edge }),
        }}
      >
        {children}
      </div>
    </Portal>
  );
}

/** A row in a Popover menu. */
export function MenuItem({ icon: Icon, label, hint, onClick, active, danger, disabled }: {
  icon?: LucideIcon;
  label: ReactNode;
  hint?: ReactNode;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cls(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors disabled:opacity-50',
        danger ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10'
          : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-ink-600',
        active && 'bg-brand-500/10 text-brand-700 dark:text-brand-300',
      )}
    >
      {Icon && <Icon size={15} className="shrink-0 opacity-75" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-faint">{hint}</span>}
    </button>
  );
}

/** Hover/focus tooltip rendered in a portal (never clipped). Wraps its children in an inline span. */
export function Tooltip({ content, side = 'top', delay = 150, className, children }: {
  content: ReactNode;
  side?: 'top' | 'bottom';
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos({ x: r.left + r.width / 2, y: side === 'top' ? r.top : r.bottom });
    }, delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setPos(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  if (content === null || content === undefined || content === '') return <>{children}</>;
  return (
    <span ref={ref} className={cls('inline-flex', className)} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {pos && (
        <Portal>
          <span
            role="tooltip"
            className="pointer-events-none fixed z-[80] max-w-xs rounded-md bg-ink-800 px-2 py-1 text-[11px] font-medium leading-snug text-zinc-100 shadow-pop animate-fade-in dark:bg-zinc-100 dark:text-ink-900"
            style={{
              left: Math.min(Math.max(8, pos.x), window.innerWidth - 8),
              top: pos.y,
              transform: side === 'top' ? 'translate(-50%, calc(-100% - 6px))' : 'translate(-50%, 6px)',
            }}
          >
            {content}
          </span>
        </Portal>
      )}
    </span>
  );
}

// =============================================================================================
// Feedback: empty states, loading, progress, keys, stats
// =============================================================================================

export function EmptyState({ icon: Icon, title, description, action, compact, className }: {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** Smaller padding, for empty lists inside cards. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cls(
      'flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-300 text-center dark:border-ink-500',
      compact ? 'gap-1.5 px-4 py-6' : 'grid-bg gap-2 px-6 py-14',
      className,
    )}>
      <span className={cls('grid place-items-center rounded-xl', TONE.brand.icon, compact ? 'mb-1 h-9 w-9' : 'mb-2 h-12 w-12')}>
        <Icon size={compact ? 17 : 22} />
      </span>
      <p className={cls('font-semibold text-zinc-800 dark:text-zinc-100', compact ? 'text-sm' : 'text-base')}>{title}</p>
      {description && <p className="max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cls('animate-spin text-brand-500', className)} aria-label="Loading" />;
}

/** Shimmer placeholder. Give it a size (`className="h-4 w-40"`), or `lines` for a text block. */
export function Skeleton({ className, lines }: { className?: string; lines?: number }) {
  if (lines && lines > 1) {
    return (
      <div className={cls('space-y-2', className)} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="shimmer h-3 rounded" style={{ width: i === lines - 1 ? '60%' : `${92 - (i % 3) * 7}%` }} />
        ))}
      </div>
    );
  }
  return <div className={cls('shimmer rounded-md', className ?? 'h-4 w-full')} aria-hidden />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cls(
      'inline-flex h-5 min-w-5 items-center justify-center rounded border border-zinc-300 bg-zinc-50 px-1 font-sans text-[10px] font-semibold text-zinc-500',
      'dark:border-ink-400 dark:bg-ink-700 dark:text-zinc-400',
      className,
    )}>
      {children}
    </kbd>
  );
}

/** Horizontal progress bar; `value` is a 0-1 ratio. `tone="ai"` uses the AI gradient. */
export function ProgressBar({ value, tone = 'brand', size = 'sm', striped, label, showValue, className }: {
  value: number;
  tone?: Tone | 'ai';
  size?: 'xs' | 'sm' | 'md';
  /** Animated stripes for work in progress. */
  striped?: boolean;
  label?: ReactNode;
  showValue?: boolean;
  className?: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100);
  const height = size === 'xs' ? 'h-1' : size === 'sm' ? 'h-1.5' : 'h-2.5';
  return (
    <div className={cls('min-w-0', className)}>
      {(label || showValue) && (
        <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted">
          <span className="truncate">{label}</span>
          {showValue && <span className="num font-semibold text-zinc-700 dark:text-zinc-300">{pct}%</span>}
        </div>
      )}
      <div
        className={cls('w-full overflow-hidden rounded-full bg-zinc-200/80 dark:bg-ink-600', height)}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cls(
            'h-full rounded-full transition-[width] duration-500',
            tone === 'ai' ? 'bg-gradient-to-r from-brand-500 to-amber-500' : TONE[tone].dot,
            striped && 'stripes animate-progress-stripes',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * KPI tile: label, big value, optional sub-line, icon, sparkline trend and delta. Clickable tiles
 * deep-link to the filtered view ("few clicks" rule).
 */
export function Stat({ label, value, sub, icon: Icon, tone = 'brand', trend, delta, onClick, loading, className }: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  /** Recent values, oldest first (sparkline). */
  trend?: number[];
  /** Signed change; `good` says whether up is good (colour = direction × goodness). */
  delta?: { value: number; label?: string; good?: 'up' | 'down' };
  onClick?: () => void;
  loading?: boolean;
  className?: string;
}) {
  const Tag = onClick ? 'button' : 'div';
  const deltaGood = delta && delta.value !== 0 && ((delta.value > 0) === ((delta.good ?? 'up') === 'up'));
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cls(
        'card flex min-w-0 flex-col gap-2 p-4 text-left',
        onClick && 'transition-colors hover:border-brand-500/60 focus-visible:border-brand-500',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="label-xs truncate">{label}</span>
        {Icon && (
          <span className={cls('grid h-7 w-7 shrink-0 place-items-center rounded-lg', TONE[tone].icon)}>
            <Icon size={14} />
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton className="h-8 w-20" />
      ) : (
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[1.75rem] font-bold leading-none tracking-tight text-zinc-900 dark:text-white">{value}</div>
            {(sub || delta) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                {delta && delta.value !== 0 && (
                  <span className={cls('num font-semibold', deltaGood ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                    {delta.value > 0 ? '▲' : '▼'} {Math.abs(delta.value)}{delta.label ?? ''}
                  </span>
                )}
                {sub && <span className="truncate">{sub}</span>}
              </div>
            )}
          </div>
          {trend && trend.length > 1 && <Sparkline values={trend} width={84} height={28} className="shrink-0" />}
        </div>
      )}
    </Tag>
  );
}

// =============================================================================================
// Toasts
// =============================================================================================

export type ToastTone = 'info' | 'success' | 'error' | 'warn';

export interface ToastOptions {
  /** One action button (e.g. Undo). */
  action?: { label: string; onClick: () => void };
  /** ms; default 4 s, 7 s for errors. */
  duration?: number;
}

export interface ToastApi {
  push: (message: string, tone?: ToastTone, opts?: ToastOptions) => void;
  success: (message: string, opts?: ToastOptions) => void;
  info: (message: string, opts?: ToastOptions) => void;
  warn: (message: string, opts?: ToastOptions) => void;
  /** Accepts any thrown value: ApiError messages are already readable English. */
  error: (err: unknown, opts?: ToastOptions) => void;
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
  tone: ToastTone;
}

const NOOP_TOAST: ToastApi = { push: () => {}, success: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const ToastContext = createContext<ToastApi>(NOOP_TOAST);

export const useToast = (): ToastApi => useContext(ToastContext);

const TOAST_ICON: Record<ToastTone, { icon: LucideIcon; color: string }> = {
  info: { icon: Info, color: 'text-sky-500' },
  success: { icon: CheckCircle2, color: 'text-emerald-500' },
  error: { icon: XCircle, color: 'text-rose-500' },
  warn: { icon: AlertTriangle, color: 'text-amber-500' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const api = useMemo<ToastApi>(() => {
    const push = (message: string, tone: ToastTone = 'info', opts: ToastOptions = {}) => {
      const id = ++counter.current;
      setToasts((prev) => [...prev.slice(-4), { id, message, tone, ...opts }]);
      setTimeout(() => dismiss(id), opts.duration ?? (tone === 'error' ? 7000 : 4000));
    };
    return {
      push,
      success: (m, o) => push(m, 'success', o),
      info: (m, o) => push(m, 'info', o),
      warn: (m, o) => push(m, 'warn', o),
      error: (err, o) => push(errorMessage(err), 'error', o),
    };
  }, [dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 no-print" aria-live="polite">
        {toasts.map((t) => {
          const { icon: Icon, color } = TOAST_ICON[t.tone];
          return (
            <div key={t.id} className="card pointer-events-auto flex items-start gap-2.5 p-3 shadow-pop animate-slide-up">
              <Icon size={17} className={cls('mt-px shrink-0', color)} />
              <p className="min-w-0 flex-1 whitespace-pre-line break-words text-[13px] leading-snug text-zinc-700 dark:text-zinc-200">{t.message}</p>
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                  className="shrink-0 text-xs font-bold text-brand-600 hover:underline dark:text-brand-400"
                >
                  {t.action.label}
                </button>
              )}
              <button type="button" onClick={() => dismiss(t.id)} className="shrink-0 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200" aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * `const [busy, run] = useBusy()` — runs an async action under a key, exposes which key is busy
 * (for `busy={busy === 'save'}`) and toasts the error message if it throws.
 */
export function useBusy(): [string | null, (key: string, fn: () => Promise<unknown>) => Promise<void>] {
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const run = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return [busy, run];
}

// =============================================================================================
// Confirm dialogs (with optional reason)
// =============================================================================================

export type ConfirmTone = 'info' | 'warning' | 'danger';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  tone?: ConfirmTone;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Explicit clicks required (1-3). Use 2 for production releases, Jira writes and gate overrides:
   * each step escalates the wording so nobody approves a write by reflex.
   */
  steps?: 1 | 2 | 3;
}

export interface ReasonOptions extends ConfirmOptions {
  reasonLabel?: string;
  reasonPlaceholder?: string;
  /** Default true: the confirm button stays disabled until a reason is typed. */
  reasonRequired?: boolean;
  defaultReason?: string;
}

type ConfirmRequest = ReasonOptions & { withReason: boolean; resolve: (value: string | null) => void };

interface ConfirmApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  confirmWithReason: (opts: ReasonOptions) => Promise<string | null>;
}

const ConfirmContext = createContext<ConfirmApi>({
  confirm: () => Promise.resolve(false),
  confirmWithReason: () => Promise.resolve(null),
});

/** `if (await confirm({title, message, tone: 'danger'})) …` */
export const useConfirm = () => useContext(ConfirmContext).confirm;
/** `const reason = await confirmWithReason({...}); if (reason === null) return;` */
export const useConfirmReason = () => useContext(ConfirmContext).confirmWithReason;

const CONFIRM_TONE: Record<ConfirmTone, { icon: LucideIcon; tone: Tone; button: ButtonVariant }> = {
  info: { icon: Info, tone: 'sky', button: 'primary' },
  warning: { icon: AlertTriangle, tone: 'amber', button: 'primary' },
  danger: { icon: ShieldAlert, tone: 'rose', button: 'danger' },
};

const STEP_COPY = ['', 'Are you sure? This cannot be undone automatically.', 'Last check — confirm one more time to proceed.'];

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const [step, setStep] = useState(1);
  const [reason, setReason] = useState('');
  const pending = useRef<ConfirmRequest | null>(null);

  const api = useMemo<ConfirmApi>(() => {
    // A newer request supersedes an open one: the older caller gets "cancelled" — never a promise
    // that hangs forever with its button stuck busy.
    const open = (next: ConfirmRequest) => {
      pending.current?.resolve(null);
      pending.current = next;
      setStep(1);
      setReason(next.defaultReason ?? '');
      setReq(next);
    };
    return {
      confirm: (opts) => new Promise<boolean>((resolve) => open({ ...opts, withReason: false, resolve: (v) => resolve(v !== null) })),
      confirmWithReason: (opts) => new Promise<string | null>((resolve) => open({ ...opts, withReason: true, resolve })),
    };
  }, []);

  const settle = (value: string | null) => {
    pending.current?.resolve(value);
    pending.current = null;
    setReq(null);
  };

  const steps = req?.steps ?? 1;
  const tone = CONFIRM_TONE[req?.tone ?? 'warning'];
  const needsReason = !!req?.withReason && (req.reasonRequired ?? true);
  const isFinal = step >= steps;
  const advance = () => {
    if (!req) return;
    if (!isFinal) setStep((s) => s + 1);
    else settle(req.withReason ? reason.trim() : '');
  };

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      <Modal
        open={req !== null}
        onClose={() => settle(null)}
        title={req?.title ?? ''}
        subtitle={steps > 1 ? `Step ${step} of ${steps}` : undefined}
        icon={tone.icon}
        iconTone={tone.tone}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => settle(null)}>{req?.cancelLabel ?? 'Cancel'}</Button>
            <Button
              variant={tone.button}
              onClick={advance}
              disabled={isFinal && needsReason && !reason.trim()}
            >
              {isFinal ? req?.confirmLabel ?? 'Confirm' : 'Continue'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-zinc-600 dark:text-zinc-300">
          {req?.message && <div>{req.message}</div>}
          {step > 1 && <p className="font-semibold text-zinc-800 dark:text-zinc-100">{STEP_COPY[step - 1]}</p>}
          {req?.withReason && (
            <Field label={req.reasonLabel ?? 'Reason'} required={needsReason}>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={req.reasonPlaceholder ?? 'Explain why — this is recorded in the audit trail.'}
                minRows={3}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) advance();
                }}
              />
            </Field>
          )}
        </div>
      </Modal>
    </ConfirmContext.Provider>
  );
}
