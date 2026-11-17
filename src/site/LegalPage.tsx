import React, { useState, useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { CONTACT_EMAIL, PRIVACY_EMAIL, mailto } from './utils/contact';

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
      <div className="border-b border-gray-700 bg-gray-900/80 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-8 py-4 flex items-center gap-4">
          <button onClick={() => onNavigate('/')} className="text-gray-500 hover:text-white transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="text-white font-bold text-lg cursor-pointer" onClick={() => onNavigate('/')}>wicklee</span>
        </div>
      </div>

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

const TermsOfService: React.FC = () => (
  <>
    <h1>Terms of Service</h1>
    <p>These Terms of Service ("Terms") govern your use of Wicklee ("Service"). Wicklee is a product of Noorth Labs ("Noorth Labs", "we", "us", "our"), which operates the Service. By using the Service, you agree to these Terms.</p>

    <h2>1. Service Description</h2>
    <p>Wicklee provides evidence-based diagnostics, model readiness and performance verification for self-hosted AI inference. The Service consists of:</p>
    <ul>
      <li><strong>Agent:</strong> A local binary installed on your machine(s) that collects hardware and inference telemetry. The agent runs entirely on your device and does not transmit data unless you explicitly enable fleet pairing.</li>
      <li><strong>Cloud Dashboard:</strong> An optional hosted service at wicklee.dev for fleet aggregation, team collaboration, and alerting.</li>
      <li><strong>API:</strong> REST and MCP endpoints for programmatic access to fleet telemetry.</li>
    </ul>

    <h2>2. Accounts</h2>
    <p>Cloud features require an account. You are responsible for maintaining the security of your account credentials. You must provide accurate information when creating an account. One person or legal entity may not maintain more than one free account.</p>

    <h2>3. Charges</h2>
    <p>The Service is currently offered at no charge. There are no paid plans and no payment is taken.</p>

    <h2>4. Data and Sovereignty</h2>
    <p>The Wicklee agent is designed to be sovereign by default:</p>
    <ul>
      <li>The agent runs locally and makes no outbound connections unless you explicitly enable fleet pairing.</li>
      <li>When fleet pairing is enabled, hardware telemetry (CPU, GPU, memory, power, thermal state, inference metrics) is transmitted to wicklee.dev for aggregation.</li>
      <li>We do not collect, store, or transmit your inference prompts, model outputs, or any content processed by your AI models.</li>
      <li>You may unpair from the fleet at any time, immediately stopping all data transmission.</li>
    </ul>

    <h2>5. Acceptable Use</h2>
    <p>You agree not to:</p>
    <ul>
      <li>Reverse engineer, decompile, or disassemble the Service beyond what is permitted by the FSL-1.1-Apache-2.0 license.</li>
      <li>Use the Service to compete with Wicklee by offering a hosted or managed monitoring service based on our software.</li>
      <li>Transmit malicious data or attempt to exploit the Service infrastructure.</li>
      <li>Share API keys or account access with unauthorized parties.</li>
      <li>Exceed the API rate limits applied to your account.</li>
    </ul>

    <h2>6. License</h2>
    <p>The Wicklee software is licensed under FSL-1.1-Apache-2.0 (Functional Source License). This means:</p>
    <ul>
      <li>You may use, copy, modify, and redistribute the software for any purpose except competing with Wicklee as a hosted service.</li>
      <li>After four years from each release date, the software converts to Apache 2.0 (fully permissive open source).</li>
    </ul>

    <h2>7. Availability and Support</h2>
    <p>We strive to maintain high availability but do not guarantee specific uptime for the cloud service unless an Enterprise agreement says otherwise. The local agent operates independently and is not affected by cloud service availability. Support is provided on a best-effort basis via GitHub issues.</p>

    <h2>8. Limitation of Liability</h2>
    <p>The Service is provided "as is" without warranty of any kind. We are not liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service. Our total liability is limited to the amount you paid for the Service in the 12 months preceding the claim.</p>

    <h2>9. Termination</h2>
    <p>We may suspend or terminate your account for violations of these Terms. Upon termination, your access to cloud features will cease, but the local agent will continue to function independently. Cloud data is then handled as described in the <a href="/privacy">Privacy Policy</a>.</p>

    <h2>10. Governing Law and Disputes</h2>
    <p>These Terms are governed by the laws of the Commonwealth of Virginia, United States, without regard to its conflict-of-law rules. Any dispute arising out of or relating to these Terms or the Service will be brought exclusively in the state or federal courts located in the Commonwealth of Virginia, and you and we consent to the personal jurisdiction of those courts. Nothing in this section limits any mandatory consumer protection rights you have under the law of the country where you live.</p>

    <h2>11. Changes to Terms</h2>
    <p>We may update these Terms from time to time. Material changes will be communicated via email or dashboard notification at least 30 days in advance. Continued use of the Service after changes constitutes acceptance.</p>

    <h2>12. Contact</h2>
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
      <li><strong>Service operation:</strong> Account information is used for authentication and support.</li>
      <li><strong>Product improvement:</strong> Aggregated, anonymized usage patterns may inform product development. We do not sell or share individual telemetry data.</li>
    </ul>

    <h2>4. Data Storage and Retention</h2>
    <ul>
      <li><strong>Local data:</strong> The agent stores metrics in a local DuckDB database on your machine: 1-second samples for 24 hours, 1-minute aggregates for 30 days, and 1-hour aggregates for 90 days. This data never leaves your device unless fleet pairing is enabled.</li>
      <li><strong>Cloud data:</strong> Raw telemetry is rolled up into 5-minute aggregates after 24 hours and kept no longer than 2 days. 5-minute aggregates are kept for up to 12 months. Node events and resolved observations are kept for 30 days.</li>
      <li><strong>Account data:</strong> Retained for the lifetime of your account and deleted within 30 days of account closure.</li>
    </ul>

    <h2>5. Data Sharing and Service Providers</h2>
    <p>We do not sell your data. We share information only with the service providers below, and only as needed for them to provide their service:</p>
    <ul>
      <li><strong>Clerk:</strong> Authentication and account management (email, name, sign-in data).</li>
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
    <p>wicklee.dev uses essential cookies for authentication (via Clerk). We use Cloudflare analytics for basic page view metrics. We do not use advertising or tracking cookies.</p>

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
    <p>There is nothing to refund. The Service is offered at no charge, no payment is taken, and there are no paid plans. The paid tiers that this policy previously covered have been withdrawn.</p>
    <p>If you were charged for a Wicklee subscription in the past and want to raise it, email <a href={mailto(CONTACT_EMAIL)}>{CONTACT_EMAIL}</a>.</p>
    <p>If paid plans are introduced in future, a refund policy will be published before any charge is taken.</p>
  </>
);

export default LegalPage;
