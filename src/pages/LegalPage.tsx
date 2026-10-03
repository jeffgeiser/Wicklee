import React, { useState, useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { CONTACT_EMAIL, PRIVACY_EMAIL, mailto } from '../utils/contact';

type LegalTab = 'terms' | 'privacy' | 'refund';

interface LegalPageProps {
  onNavigate: (path: string) => void;
  initialTab?: LegalTab;
}

const LegalPage: React.FC<LegalPageProps> = ({ onNavigate, initialTab = 'terms' }) => {
  const [activeTab, setActiveTab] = useState<LegalTab>(initialTab);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activeTab]);

  const tabs: { id: LegalTab; label: string }[] = [
    { id: 'terms', label: 'Terms of Service' },
    { id: 'privacy', label: 'Privacy Policy' },
    { id: 'refund', label: 'Refund Policy' },
  ];

  return (
    <div className="min-h-screen bg-gray-900 text-gray-300">
      {/* Header */}
      <div className="border-b border-gray-700 bg-gray-900/80 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-8 py-4 flex items-center gap-4">
          <button onClick={() => onNavigate('/')} className="text-gray-500 hover:text-white transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="text-white font-bold text-lg cursor-pointer" onClick={() => onNavigate('/')}>wicklee</span>
        </div>
      </div>

      {/* Tab nav */}
      <div className="max-w-4xl mx-auto px-4 sm:px-8 pt-8">
        <div className="flex gap-1 border-b border-gray-700 mb-8">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === t.id
                  ? 'text-white border-blue-500'
                  : 'text-gray-500 border-transparent hover:text-gray-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-8 pb-20">
        <div className="prose prose-invert prose-sm max-w-none [&_h1]:text-white [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-6 [&_h2]:text-white [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-8 [&_h2]:mb-3 [&_h3]:text-white [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-6 [&_h3]:mb-2 [&_p]:mb-3 [&_p]:leading-relaxed [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:mb-1.5 [&_a]:text-blue-400 [&_a]:underline">
          {activeTab === 'terms' && <TermsOfService />}
          {activeTab === 'privacy' && <PrivacyPolicy />}
          {activeTab === 'refund' && <RefundPolicy />}
        </div>
        <p className="text-xs text-gray-600 mt-12">Last updated: October 3, 2026</p>
      </div>
    </div>
  );
};

// Every "Paddle" mention below describes Paddle.com as merchant of record,
// not a mere processor: Paddle sells the subscription to the buyer, so the
// Terms, Privacy and Refund tabs must agree on that. Plan contents follow the
// cards in src/components/PricingPage.tsx (the source of truth) and retention
// follows cloud/src/maintenance.rs + agent/src/store.rs — change them together.

const TermsOfService: React.FC = () => (
  <>
    <h1>Terms of Service</h1>
    <p>These Terms of Service ("Terms") govern your use of Wicklee ("Service"). Wicklee is a product of Noorth Labs ("Noorth Labs", "we", "us", "our"), which operates the Service. By using the Service, you agree to these Terms.</p>

    <h2>1. Service Description</h2>
    <p>Wicklee is a sovereign GPU fleet monitoring platform for self-hosted AI inference. The Service consists of:</p>
    <ul>
      <li><strong>Agent:</strong> A local binary installed on your machine(s) that collects hardware and inference telemetry. The agent runs entirely on your device and does not transmit data unless you explicitly enable fleet pairing.</li>
      <li><strong>Cloud Dashboard:</strong> An optional hosted service at wicklee.dev for fleet aggregation, team collaboration, and alerting.</li>
      <li><strong>API:</strong> REST and MCP endpoints for programmatic access to fleet telemetry.</li>
    </ul>

    <h2>2. Accounts</h2>
    <p>Cloud features require an account. You are responsible for maintaining the security of your account credentials. You must provide accurate information when creating an account. One person or legal entity may not maintain more than one free account.</p>

    <h2>3. Plans</h2>
    <p>The Service is offered in the plans below. The <a href="/pricing">pricing page</a> has the full, current feature list for each plan; if it and this summary ever differ, the pricing page applies.</p>
    <ul>
      <li><strong>Community (free):</strong> Unlimited local nodes, up to 3 nodes in the cloud fleet view, 24-hour cloud metric history, local API and MCP server, Fleet API core endpoints at 60 requests/minute, and community support via GitHub issues.</li>
      <li><strong>Team ($99/month or $990/year for up to 10 nodes; $200/month or $2,000/year for up to 25 nodes):</strong> Everything in Community, plus up to 10 or 25 nodes in the cloud fleet view depending on plan size, 90-day metric history, Fleet API at 600 requests/minute plus the analytics endpoints, cost and chargeback reports, idle-waste and right-sizing reports, capacity planning, SLOs with error budgets, benchmark report export, and email support. Both sizes have the same features; the size sets the node limit.</li>
      <li><strong>Enterprise:</strong> Custom pricing and terms set out in a separate written agreement. Everything in Team, plus options such as a self-hosted control plane, SSO/SAML, audit log export and SIEM streaming, extended metric history, a service level agreement, and dedicated support.</li>
    </ul>
    <p>Prices are in US dollars and exclude applicable taxes. Sales tax, VAT, or GST is calculated by Paddle at checkout based on your location and added to the price shown. Pricing is subject to change with 30 days notice to existing subscribers.</p>

    <h2>4. Billing and Merchant of Record</h2>
    <p>Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders: Paddle sells the subscription to you, handles billing and invoicing, collects and remits sales tax and VAT, and appears on your card or bank statement. Paddle provides all customer service inquiries and handles returns related to payment. Your purchase is also subject to <a href="https://www.paddle.com/legal/buyer-terms" target="_blank" rel="noopener noreferrer">Paddle's Buyer Terms</a>.</p>
    <p>Paid subscriptions are billed in advance, monthly or annually. By subscribing, you authorize recurring charges. Subscriptions renew automatically at the end of each billing period unless cancelled before the renewal date.</p>

    <h2>5. Cancellation</h2>
    <p>You may cancel a paid subscription at any time, using the subscription management link in any Paddle receipt or subscription email (or by looking up your order at <a href="https://paddle.net" target="_blank" rel="noopener noreferrer">paddle.net</a>), or by emailing <a href={mailto(CONTACT_EMAIL)}>{CONTACT_EMAIL}</a> from your account email. Cancellation stops the next renewal; you keep paid features until the end of the billing period you have already paid for, after which your account moves to the Community plan. Cancelling does not by itself trigger a refund; see the <a href="/refund">Refund Policy</a>.</p>

    <h2>6. Data and Sovereignty</h2>
    <p>The Wicklee agent is designed to be sovereign by default:</p>
    <ul>
      <li>The agent runs locally and makes no outbound connections unless you explicitly enable fleet pairing.</li>
      <li>When fleet pairing is enabled, hardware telemetry (CPU, GPU, memory, power, thermal state, inference metrics) is transmitted to wicklee.dev for aggregation.</li>
      <li>We do not collect, store, or transmit your inference prompts, model outputs, or any content processed by your AI models.</li>
      <li>You may unpair from the fleet at any time, immediately stopping all data transmission.</li>
    </ul>

    <h2>7. Acceptable Use</h2>
    <p>You agree not to:</p>
    <ul>
      <li>Reverse engineer, decompile, or disassemble the Service beyond what is permitted by the FSL-1.1-Apache-2.0 license.</li>
      <li>Use the Service to compete with Wicklee by offering a hosted or managed monitoring service based on our software.</li>
      <li>Transmit malicious data or attempt to exploit the Service infrastructure.</li>
      <li>Share API keys or account access with unauthorized parties.</li>
      <li>Exceed the API rate limits for your plan (60 requests/minute on Community, 600 requests/minute on Team).</li>
    </ul>

    <h2>8. License</h2>
    <p>The Wicklee software is licensed under FSL-1.1-Apache-2.0 (Functional Source License). This means:</p>
    <ul>
      <li>You may use, copy, modify, and redistribute the software for any purpose except competing with Wicklee as a hosted service.</li>
      <li>After four years from each release date, the software converts to Apache 2.0 (fully permissive open source).</li>
    </ul>

    <h2>9. Availability and Support</h2>
    <p>We strive to maintain high availability but do not guarantee specific uptime for the cloud service unless an Enterprise agreement says otherwise. The local agent operates independently and is not affected by cloud service availability. Support is provided on a best-effort basis via GitHub issues for Community and via email for paid plans.</p>

    <h2>10. Limitation of Liability</h2>
    <p>The Service is provided "as is" without warranty of any kind. We are not liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service. Our total liability is limited to the amount you paid for the Service in the 12 months preceding the claim.</p>

    <h2>11. Termination</h2>
    <p>We may suspend or terminate your account for violations of these Terms. Upon termination, your access to cloud features will cease, but the local agent will continue to function independently. Cloud data is then handled as described in the <a href="/privacy">Privacy Policy</a>.</p>

    <h2>12. Governing Law and Disputes</h2>
    <p>These Terms are governed by the laws of the Commonwealth of Virginia, United States, without regard to its conflict-of-law rules. Any dispute arising out of or relating to these Terms or the Service will be brought exclusively in the state or federal courts located in the Commonwealth of Virginia, and you and we consent to the personal jurisdiction of those courts. Nothing in this section limits any mandatory consumer protection rights you have under the law of the country where you live.</p>

    <h2>13. Changes to Terms</h2>
    <p>We may update these Terms from time to time. Material changes will be communicated via email or dashboard notification at least 30 days in advance. Continued use of the Service after changes constitutes acceptance.</p>

    <h2>14. Contact</h2>
    <p>Questions about these Terms? Contact Noorth Labs at <a href={mailto(CONTACT_EMAIL)}>{CONTACT_EMAIL}</a>.</p>
  </>
);

const PrivacyPolicy: React.FC = () => (
  <>
    <h1>Privacy Policy</h1>
    <p>This Privacy Policy explains how Noorth Labs ("we", "us", "our"), which makes and operates Wicklee, collects, uses, and protects your information.</p>

    <h2>1. Our Privacy Principle</h2>
    <p>Wicklee is built on a principle of structural privacy. The agent runs entirely on your machine and makes zero outbound connections by default. We can only receive data you explicitly choose to send by enabling fleet pairing.</p>

    <h2>2. Information We Collect</h2>

    <h3>When you use the local agent only (no fleet pairing):</h3>
    <p>We collect nothing. The agent operates entirely on your device. No data leaves your machine.</p>

    <h3>When you enable fleet pairing:</h3>
    <ul>
      <li><strong>Hardware telemetry:</strong> CPU usage, GPU utilization, memory pressure, power consumption, thermal state, swap activity.</li>
      <li><strong>Inference metrics:</strong> Tokens per second, TTFT, model names, runtime status (Ollama/vLLM/llama.cpp), inference state.</li>
      <li><strong>Node metadata:</strong> Node ID, hostname, OS, architecture, GPU name, agent version.</li>
    </ul>

    <h3>When you create a cloud account:</h3>
    <ul>
      <li><strong>Account information:</strong> Email address, name (provided via Clerk authentication).</li>
      <li><strong>Subscription data:</strong> Plan, billing status, and subscription and customer identifiers. Payments are taken by Paddle.com as merchant of record; Paddle collects your payment and billing details directly and we never receive or store your card details.</li>
    </ul>

    <h3>What we never collect:</h3>
    <ul>
      <li>Your prompts, model inputs, or inference outputs.</li>
      <li>File contents on your machine.</li>
      <li>Browsing history or application usage beyond inference runtimes.</li>
      <li>Personal data from your local network.</li>
    </ul>

    <h2>3. How We Use Your Information</h2>
    <ul>
      <li><strong>Fleet aggregation:</strong> Hardware telemetry is displayed on your fleet dashboard and used for pattern detection and alerting.</li>
      <li><strong>Service operation:</strong> Account information is used for authentication, billing, and support.</li>
      <li><strong>Product improvement:</strong> Aggregated, anonymized usage patterns may inform product development. We do not sell or share individual telemetry data.</li>
    </ul>

    <h2>4. Data Storage and Retention</h2>
    <ul>
      <li><strong>Local data:</strong> The agent stores metrics in a local DuckDB database on your machine: 1-second samples for 24 hours, 1-minute aggregates for 30 days, and 1-hour aggregates for 90 days. This data never leaves your device unless fleet pairing is enabled.</li>
      <li><strong>Cloud data:</strong> Raw telemetry is rolled up into 5-minute aggregates after 24 hours and kept no longer than 2 days. 5-minute aggregates are kept for up to 12 months; how much history you can view depends on your plan (24 hours on Community, 90 days on Team). Node events and resolved observations are kept for 30 days.</li>
      <li><strong>Account data:</strong> Retained for the lifetime of your account and deleted within 30 days of account closure.</li>
    </ul>

    <h2>5. Data Sharing and Service Providers</h2>
    <p>We do not sell your data. We share information only with the service providers below, and only as needed for them to provide their service:</p>
    <ul>
      <li><strong>Clerk:</strong> Authentication and account management (email, name, sign-in data).</li>
      <li><strong>Paddle.com:</strong> Merchant of record for all purchases. Paddle sells the subscription to you and processes your payment, billing details, invoices, and sales tax/VAT under its own privacy policy, and shares subscription status with us.</li>
      <li><strong>Railway:</strong> Cloud hosting and database (data is encrypted in transit and at rest).</li>
      <li><strong>Cloudflare:</strong> Website delivery, bot protection on sign-in (Turnstile), email routing for our wicklee.dev addresses, and privacy-friendly page-view analytics.</li>
      <li><strong>Resend:</strong> Delivery of alert and weekly digest emails (recipient email address and message content).</li>
      <li><strong>Google Fonts:</strong> Web fonts loaded by wicklee.dev pages (your browser requests the fonts, which shares your IP address with Google).</li>
    </ul>
    <p>If you configure integrations such as Slack, PagerDuty, webhooks, OpenTelemetry, or SIEM export, we send the alert or telemetry data you choose to the destination you configure. We may disclose information if required by law or to protect our rights.</p>

    <h2>6. Your Rights</h2>
    <ul>
      <li><strong>Unpair:</strong> Disconnect your node from the fleet at any time to immediately stop all data transmission.</li>
      <li><strong>Export:</strong> Download your telemetry data via the API or dashboard export feature.</li>
      <li><strong>Delete:</strong> Request deletion of your account and associated data by contacting us.</li>
      <li><strong>Access:</strong> Request a copy of all data we hold about you.</li>
    </ul>

    <h2>7. Security</h2>
    <ul>
      <li>All cloud communication uses TLS encryption.</li>
      <li>Telemetry ingestion requires authenticated session tokens.</li>
      <li>API keys are SHA-256 hashed at rest.</li>
      <li>The agent configuration file is written with restricted permissions (0600).</li>
      <li>The agent binds to localhost by default; LAN access is opt-in.</li>
    </ul>

    <h2>8. Cookies</h2>
    <p>wicklee.dev uses essential cookies for authentication (via Clerk) and checkout (via Paddle). We use Cloudflare analytics for basic page view metrics. We do not use advertising or tracking cookies.</p>

    <h2>9. Children</h2>
    <p>The Service is not directed at children under 16. We do not knowingly collect information from children.</p>

    <h2>10. Changes</h2>
    <p>We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated date.</p>

    <h2>11. Contact</h2>
    <p>Privacy questions? Contact Noorth Labs at <a href={mailto(PRIVACY_EMAIL)}>{PRIVACY_EMAIL}</a>.</p>
  </>
);

const RefundPolicy: React.FC = () => (
  <>
    <h1>Refund Policy</h1>
    <p>We want you to be satisfied with Wicklee. This policy explains how refunds work for paid subscriptions. Purchases are made through Paddle.com, our merchant of record, which issues all refunds.</p>

    <h2>1. Community (Free)</h2>
    <p>The Community plan is free and requires no payment. No refund applies.</p>

    <h2>2. Team Subscriptions</h2>
    <p>Team is billed monthly or annually, at either plan size (up to 10 or up to 25 nodes). The same rules apply to both sizes.</p>

    <h3>14-Day Money-Back Guarantee</h3>
    <p>You may request a full refund within 14 days of your initial purchase of a Team subscription, and within 14 days of each annual renewal charge. No questions asked; telling us why is optional.</p>

    <h3>After 14 Days</h3>
    <ul>
      <li><strong>Annual billing:</strong> After the 14-day window, the current annual period is non-refundable. Cancelling stops the next renewal, and you keep Team features until the end of the paid year.</li>
      <li><strong>Monthly billing:</strong> Monthly renewal charges are not refundable once made. You can cancel at any time; cancelling stops the next renewal, and you keep Team features until the end of the paid month.</li>
    </ul>
    <p>See the <a href="/terms">Terms of Service</a> for how to cancel.</p>

    <h2>3. Plan Changes</h2>
    <p>To change plan size, email <a href={mailto(CONTACT_EMAIL)}>{CONTACT_EMAIL}</a>.</p>
    <ul>
      <li><strong>Upgrades</strong> (for example, Team 10 nodes to Team 25 nodes) take effect immediately. Paddle prorates the charge, crediting the unused part of your current period against the new price.</li>
      <li><strong>Downgrades</strong> (Team 25 nodes to Team 10 nodes, or Team to Community) take effect at the start of your next billing period. You keep your current plan until then, and no partial refund is issued for the remainder of the current period.</li>
    </ul>

    <h2>4. Service Issues</h2>
    <p>If the cloud service experiences significant downtime or degradation that materially affects your use, contact us and we will work with you on a fair resolution, such as a service credit. This is in addition to the 14-day guarantee above. The local agent is not affected by cloud service availability and continues to function independently.</p>

    <h2>5. How to Request a Refund</h2>
    <p>Email <a href={mailto(CONTACT_EMAIL)}>{CONTACT_EMAIL}</a> from your account email (or include it), ideally with your Paddle order number from your receipt. You can also contact Paddle directly for help with a refund or charge, using the link in your Paddle receipt email or at <a href="https://paddle.net" target="_blank" rel="noopener noreferrer">paddle.net</a>. Refunds are issued by Paddle to your original payment method and typically appear within 5–10 business days.</p>

    <h2>6. Enterprise</h2>
    <p>Enterprise contracts have separate terms. Refunds for Enterprise customers are governed by the individual agreement.</p>
  </>
);

export default LegalPage;
