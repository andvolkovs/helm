import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type CSSProperties, type FormEvent } from 'react';
import type { ApiToken, CreatedToken, Project, TokenScope } from '@helm/shared';
import { api, ApiError } from '../../lib/api.ts';
import { relativeTime } from '../../lib/format.ts';
import { clearUserData, keys, useCreateToken, useProjects, useRevokeToken, useTokens } from '../../lib/queries.ts';
import '../task-editor/editor.css';
import './settings.css';
import { AlertsSection } from './AlertsSection.tsx';
import { ThemeSection } from './ThemePicker.tsx';
import { UpdatesSection } from './UpdatesSection.tsx';
import { FOCUS_LAYOUTS, setFocusLayout, useFocusLayout } from '../focus/focus-layout.ts';

const ACCESS: { value: TokenScope; label: string; hint: string }[] = [
  { value: 'read', label: 'Read only', hint: 'Sees tasks, projects and the done log.' },
  { value: 'read_write', label: 'Read and change', hint: 'Also adds, edits, starts and completes tasks.' },
];

const EXPIRY: { days: number | null; label: string }[] = [
  { days: null, label: 'Never' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];

export function SettingsView() {
  const [created, setCreated] = useState<CreatedToken | null>(null);

  return (
    <main className="settings">
      <section className="settings-section" aria-labelledby="connections-heading">
        <h1 id="connections-heading" className="settings-title">
          Connect an assistant
        </h1>
        <p className="settings-lede">
          AI assistants and scripts use a token to read your board and, if you let them, change it. Each gets its
          own token, so you can see what it added and revoke it at any time.
        </p>
        {created ? (
          <SecretReveal created={created} onDone={() => setCreated(null)} />
        ) : (
          <NewTokenForm onCreated={setCreated} />
        )}
      </section>

      <TokenList />

      <ThemeSection />

      <FocusLayoutSection />

      <AlertsSection />

      <UpdatesSection />

      <SessionSection />
    </main>
  );
}

// ---------- Create ----------

function NewTokenForm({ onCreated }: { onCreated: (c: CreatedToken) => void }) {
  const nameId = useId();
  const projects = useProjects();
  const create = useCreateToken();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TokenScope>('read_write');
  const [limited, setLimited] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [days, setDays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Name the token after whatever will use it, like “Claude Code”.');
    if (limited && chosen.length === 0) return setError('Pick at least one project, or allow all of them.');
    try {
      onCreated(
        await create.mutateAsync({
          name: name.trim(),
          scope,
          projectIds: limited ? chosen : null,
          expiresInDays: days,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t create the token.');
    }
  }

  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  return (
    <form className="token-form" autoComplete="off" onSubmit={submit}>
      <div className="field">
        <label htmlFor={nameId}>Name</label>
        <input
          id={nameId}
          className="settings-input"
          autoComplete="off"
          value={name}
          maxLength={64}
          placeholder="Claude Code"
          onChange={(e) => setName(e.target.value)}
        />
        <p className="field-hint">Tasks it adds are labelled with this name.</p>
      </div>

      <fieldset className="field">
        <legend>Access</legend>
        <div className="choice-list">
          {ACCESS.map((a) => (
            <label key={a.value} className="choice">
              <input type="radio" name="token-scope" checked={scope === a.value} onChange={() => setScope(a.value)} />
              <span>
                <strong>{a.label}</strong>
                <span className="choice-hint">{a.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>Projects</legend>
        <div className="choice-list">
          <label className="choice">
            <input type="radio" name="token-projects" checked={!limited} onChange={() => setLimited(false)} />
            <span>
              <strong>All projects and the Inbox</strong>
            </span>
          </label>
          <label className="choice">
            <input type="radio" name="token-projects" checked={limited} onChange={() => setLimited(true)} />
            <span>
              <strong>Only some projects</strong>
              <span className="choice-hint">It can’t see the Inbox or create projects.</span>
            </span>
          </label>
        </div>
        {limited && (
          <div className="project-picks">
            {(projects.data ?? []).map((p) => (
              <label key={p.id} className="project-pick" style={{ '--swatch': p.color } as CSSProperties}>
                <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} />
                <span className="chart-label">{p.name}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="field">
        <legend>Expires</legend>
        <div className="chips">
          {EXPIRY.map((x) => (
            <label key={x.label} className="chip">
              <input type="radio" name="token-expiry" checked={days === x.days} onChange={() => setDays(x.days)} />
              <span>{x.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {error && (
        <p className="editor-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={create.isPending}>
          Create token
        </button>
      </div>
    </form>
  );
}

// ---------- Show once ----------

type SnippetKind = 'claude' | 'json' | 'rest';

function snippet(kind: SnippetKind, secret: string, origin: string): string {
  switch (kind) {
    case 'claude':
      return `claude mcp add --transport http helm ${origin}/mcp --header "Authorization: Bearer ${secret}"`;
    case 'json':
      return JSON.stringify(
        { mcpServers: { helm: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${secret}` } } } },
        null,
        2,
      );
    case 'rest':
      return `curl -H "Authorization: Bearer ${secret}" ${origin}/api/v1/focus`;
  }
}

const SNIPPETS: { kind: SnippetKind; label: string; hint: string }[] = [
  { kind: 'claude', label: 'Claude Code', hint: 'Run this in a terminal.' },
  { kind: 'json', label: 'MCP config', hint: 'For assistants configured with a JSON file of MCP servers.' },
  { kind: 'rest', label: 'REST API', hint: 'For scripts. Every /api/v1 endpoint accepts the token.' },
];

function SecretReveal({ created, onDone }: { created: CreatedToken; onDone: () => void }) {
  const [kind, setKind] = useState<SnippetKind>('claude');
  const origin = window.location.origin;
  const current = SNIPPETS.find((s) => s.kind === kind)!;

  return (
    <div className="token-reveal" role="region" aria-labelledby="reveal-heading">
      <h2 id="reveal-heading" className="settings-subtitle">
        Token for {created.token.name} created
      </h2>
      <p className="token-warning">Copy it now. Helm stores only a fingerprint and can’t show it again.</p>
      <CopyField label="Token" value={created.secret} />

      <fieldset className="field">
        <legend>Connect with</legend>
        <div className="chips">
          {SNIPPETS.map((s) => (
            <label key={s.kind} className="chip">
              <input type="radio" name="snippet" checked={kind === s.kind} onChange={() => setKind(s.kind)} />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="field-hint">{current.hint}</p>
      <CopyField label={current.label} value={snippet(kind, created.secret, origin)} multiline={kind === 'json'} />

      <div>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function CopyField({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  const id = useId();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard blocked: select the text so it can be copied by hand.
      (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.select();
    }
  }

  const common = {
    id,
    className: 'copy-value',
    value,
    readOnly: true,
    spellCheck: false,
    onFocus: (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => e.currentTarget.select(),
  };
  return (
    <div className="copy-field">
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      {multiline ? <textarea {...common} rows={value.split('\n').length} /> : <input {...common} />}
      <button type="button" className="btn" onClick={copy} aria-live="polite">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// ---------- List ----------

function TokenList() {
  const tokens = useTokens();
  const projects = useProjects();
  const now = new Date();
  const all = tokens.data ?? [];
  const active = all.filter((t) => !t.revokedAt && !(t.expiresAt && Date.parse(t.expiresAt) <= now.getTime()));
  const inactive = all.filter((t) => !active.includes(t));
  const names = new Map((projects.data ?? []).map((p) => [p.id, p]));

  if (tokens.isPending) return null;
  return (
    <section className="settings-section" aria-labelledby="tokens-heading">
      <h2 id="tokens-heading" className="settings-subtitle">
        Tokens
      </h2>
      {active.length === 0 ? (
        <p className="field-hint">No assistant can reach your board yet.</p>
      ) : (
        <ul className="token-list">
          {active.map((t) => (
            <TokenRow key={t.id} token={t} projects={names} now={now} />
          ))}
        </ul>
      )}
      {inactive.length > 0 && (
        <details className="token-inactive">
          <summary>Revoked and expired ({inactive.length})</summary>
          <ul className="token-list">
            {inactive.map((t) => (
              <TokenRow key={t.id} token={t} projects={names} now={now} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function TokenRow({ token, projects, now }: { token: ApiToken; projects: Map<string, Project>; now: Date }) {
  const revoke = useRevokeToken();
  const [confirming, setConfirming] = useState(false);
  const live = !token.revokedAt && !(token.expiresAt && Date.parse(token.expiresAt) <= now.getTime());

  const scopeLabel = ACCESS.find((a) => a.value === token.scope)!.label;
  const where = token.projectIds
    ? token.projectIds.map((id) => projects.get(id)?.name ?? 'archived project').join(', ')
    : 'All projects';
  const status = token.revokedAt
    ? `Revoked ${relativeTime(token.revokedAt, now)}`
    : !live
      ? `Expired ${relativeTime(token.expiresAt!, now)}`
      : token.expiresAt
        ? `Expires ${new Date(token.expiresAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`
        : null;

  return (
    <li className={`token-row${live ? '' : ' is-inactive'}`}>
      <div className="token-main">
        <p className="token-name">{token.name}</p>
        <p className="token-meta">
          <span>{scopeLabel}</span>
          <span>{where}</span>
          <span>{token.lastUsedAt ? `Used ${relativeTime(token.lastUsedAt, now)}` : 'Never used'}</span>
          {status && <span>{status}</span>}
        </p>
        <p className="token-prefix">{token.prefix}…</p>
      </div>
      {live && (
        <button
          type="button"
          className="btn btn-quiet btn-danger"
          disabled={revoke.isPending}
          onClick={() => (confirming ? revoke.mutate(token.id) : setConfirming(true))}
          onBlur={() => setConfirming(false)}
        >
          {confirming ? 'Confirm revoke' : 'Revoke'}
          <span className="visually-hidden"> {token.name}</span>
        </button>
      )}
    </li>
  );
}

// ---------- Focus layout ----------

function FocusLayoutSection() {
  const layout = useFocusLayout();
  return (
    <section className="settings-section" aria-labelledby="focus-layout-heading">
      <h2 id="focus-layout-heading" className="settings-subtitle">
        Focus layout
      </h2>
      <p className="field-hint">How the Focus view looks on this device.</p>
      <div className="choice-list" role="radiogroup" aria-labelledby="focus-layout-heading">
        {FOCUS_LAYOUTS.map((l) => (
          <label key={l.id} className="choice">
            <input type="radio" name="focus-layout" checked={layout === l.id} onChange={() => setFocusLayout(l.id)} />
            <span>
              <strong>{l.name}</strong>
              <span className="choice-hint">{l.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

// ---------- Session ----------

function SessionSection() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut(everywhere = false) {
    setBusy(true);
    setError(null);
    try {
      // The session cookie is httpOnly, so only the server can end it.
      await (everywhere ? api.logoutAll() : api.logout());
      qc.setQueryData(keys.me, { signedIn: false });
      clearUserData(qc);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t sign out.');
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby="session-heading">
      <h2 id="session-heading" className="settings-subtitle">
        This device
      </h2>
      <p className="field-hint">Signing out also removes the copy of your board kept here for offline use.</p>
      {error && (
        <p className="editor-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button type="button" className="btn" disabled={busy} onClick={() => signOut()}>
          Sign out
        </button>
      </div>
      <p className="field-hint">
        Lost a phone, or signed in somewhere you shouldn’t have? This signs out every device, this one included.
        Assistants keep their tokens.
      </p>
      <div>
        <button type="button" className="btn" disabled={busy} onClick={() => signOut(true)}>
          Sign out everywhere
        </button>
      </div>
    </section>
  );
}
