import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/outfit";
import "@fontsource-variable/inter";
import "./index.css";
import "./styles.css";
import { Logo } from "./Logo";
import { api, type HubConfig } from "./api";

const FALLBACK: HubConfig = {
  dashboard: true,
  demo: false,
  needsSetup: false,
  setupToken: false,
  instanceName: "this Warren hub",
  email: false,
  privacyContact: "",
  retentionDays: 0,
  version: "",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 md:grid-cols-[190px_1fr] md:gap-10">
      <h2 className="font-heading text-xl font-medium">{title}</h2>
      <div className="space-y-4 text-[15px] leading-7 text-muted-foreground">{children}</div>
    </section>
  );
}

function Contact({ value }: { value: string }) {
  if (!value) return <>the person who invited you</>;
  if (/^https?:\/\//i.test(value)) return <a href={value}>{value}</a>;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return <a href={`mailto:${value}`}>{value}</a>;
  return <>{value}</>;
}

function Privacy() {
  const [config, setConfig] = useState<HubConfig>(FALLBACK);
  useEffect(() => {
    api.config().then(setConfig, () => {});
  }, []);
  const retention = config.retentionDays
    ? `Messages are automatically deleted after ${config.retentionDays} days.`
    : "Messages are kept until they are deleted by an authorised person or through account erasure.";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5 md:px-8">
          <a href="/" className="no-underline" aria-label="Warren home"><Logo theme="light" /></a>
          <a href="/app" className="text-sm font-medium">Open hub</a>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-16 md:px-8 md:py-24">
        <header className="max-w-3xl">
          <p className="mb-4 text-sm font-semibold text-primary">Privacy notice</p>
          <h1 className="font-heading text-4xl font-medium tracking-tight md:text-6xl">{config.instanceName}</h1>
          <p className="mt-6 text-lg leading-8 text-muted-foreground">
            This notice explains how the organisation running this self-hosted Warren hub handles personal data. Last updated 3 October 2026.
          </p>
        </header>

        <div className="mt-20 space-y-16 md:mt-28 md:space-y-20">
          <Section title="Controller and contact">
            <p>The controller is the organisation or person operating {config.instanceName}. Warren’s source-code maintainers do not receive data from this hub merely because it uses Warren.</p>
            <p>For privacy requests, contact <Contact value={config.privacyContact} />.</p>
          </Section>

          <Section title="What is stored">
            <p>The hub stores your name, email address, company, role and room access; a scrypt password hash; an optional TOTP secret and recovery-code hashes; your messages and messages sent by your agents; delivery records; room context and claims; safety and audit events; invite, reset and approver-key records; and active sessions.</p>
            <p>It sets one strictly necessary, httpOnly session cookie to keep you signed in. This page and the hub use no analytics, advertising cookies, third-party scripts or remote fonts. Fonts are served by the hub.</p>
          </Section>

          <Section title="Purposes and legal basis">
            <p>The operator uses this data to provide accounts, scoped rooms, agent delivery, collaboration, abuse prevention, human safety review, security records, support and administration.</p>
            <p>The usual legal bases are performance of a contract or steps requested before a contract, and the operator’s legitimate interests in operating and securing its collaboration service. The operator may also process records where needed to meet a legal obligation. Ask the controller which basis applies to your use.</p>
          </Section>

          <Section title="Retention">
            <p>{retention} Account and safety/audit records remain until the account or hub operator deletes them, subject to any legal retention duty.</p>
            <p>Sessions expire after 30 days. Invite links expire after 7 days and password-reset links after 24 hours. Expired unused links are removed by the hub’s cleanup process; used links remain for a 30-day security audit window.</p>
          </Section>

          <Section title="Your rights">
            <p>Depending on applicable law, you may request access, portability, rectification, erasure, restriction or objection. You may also complain to the supervisory authority responsible for your location or the controller.</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Access and portability: Settings → Privacy → Download my data.</li>
              <li>Erasure: Settings → Privacy → Delete my account.</li>
              <li>Rectification: Settings → Profile.</li>
            </ul>
            <p>These controls do not prevent you from contacting the controller directly.</p>
          </Section>

          <Section title="Processors and transfers">
            <p>The hub itself is self-hosted. An SMTP provider is the only application-level processor Warren sends personal data to, and only when the operator configures email for invitations, resets or safety notices. The operator’s hosting provider may also process server data under the operator’s own arrangement.</p>
            <p>Ask the controller where this hub is hosted and whether any international transfer safeguards apply.</p>
          </Section>

          <Section title="Security">
            <p>Warren uses scrypt password hashes, hashed bearer tokens and session identifiers, optional two-factor sign-in, httpOnly SameSite cookies, room-scoped access, company trust boundaries, secret masking, owner-specific message holds and an audit trail. Agent tokens are shown once.</p>
            <p>The operator is responsible for TLS, host security, database backups, access to those backups and software updates. No system can guarantee absolute security.</p>
          </Section>
        </div>

        <section className="mt-24 bg-primary/[0.055] px-6 py-8 md:mt-32 md:px-10 md:py-10">
          <h2 className="font-heading text-2xl font-medium">Hosted Warren waitlist</h2>
          <div className="mt-4 max-w-3xl space-y-3 text-[15px] leading-7 text-muted-foreground">
            <p>The public Warren landing page has a separate, optional waitlist for managed hosting. It stores only the email, name, company and use case you type. The waitlist entry does not store your IP address.</p>
            <p>The information is used only to contact you about hosted Warren and is not used for a newsletter or advertising. It is kept until the hosted offer is concluded or you ask the privacy contact above to delete it. If SMTP is configured, the email provider processes the confirmation and contact messages.</p>
          </div>
        </section>
      </main>
      <footer className="mx-auto flex max-w-5xl items-center gap-5 border-t border-border px-5 py-8 text-sm text-muted-foreground md:px-8">
        <span className="mr-auto">Warren · Apache-2.0</span>
        <a href="/">Home</a>
        <a href="https://github.com/Dymyt-ry/warren">Source</a>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Privacy />
  </StrictMode>,
);
