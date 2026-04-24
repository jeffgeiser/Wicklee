import React, { useState, useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';

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
    <div className="min-h-screen bg-gray-950 text-gray-300">
      {/* Header */}
      <div className="border-b border-gray-800 bg-gray-950/80 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-8 py-4 flex items-center gap-4">
          <button onClick={() => onNavigate('/')} className="text-gray-500 hover:text-white transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="text-white font-bold text-lg cursor-pointer" onClick={() => onNavigate('/')}>wicklee</span>
        </div>
      </div>

      {/* Tab nav */}
      <div className="max-w-4xl mx-auto px-4 sm:px-8 pt-8">
        <div className="flex gap-1 border-b border-gray-800 mb-8">
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
        <p className="text-xs text-gray-600 mt-12">Last updated: April 3, 2026</p>
      </div>
    </div>
  );
};

const TermsOfService: React.FC = () => (
  <>
    <h1>Terms of Service</h1>
    <p>These Terms of Service ("Terms") govern your use of Wicklee ("Service"), operated by Wicklee ("we", "us", "our"). By using the Service, you agree to these Terms.</p>

    <h2>1. Service Description</h2>
    <p>Wicklee is a sovereign GPU fleet monitoring platform for local AI inference. The Service consists of:</p>
    <ul>
      <li><strong>Agent:</strong> A local binary installed on your machine(s) that collects hardware and inference telemetry. The agent runs entirely on your device and does not transmit data unless you explicitly enable fleet pairing.</li>
      <li><strong>Cloud Dashboard:</strong> An optional hosted service at wicklee.dev for fleet aggregation, team collaboration, and alerting.</li>
      <li><strong>API:</strong> REST and MCP endpoints for programmatic access to fleet telemetry.</li>
    </ul>

    <h2>2. Accounts</h2>
    <p>Cloud features require an account. You are responsible for maintaining the security of your account credentials. You must provide accurate information when creating an account. One person or legal entity may not maintain more than one free account.</p>

    <h2>3. Subscription Tiers</h2>
    <p>The Service is offered in multiple tiers:</p>
    <ul>
      <li><strong>Community (Free):</strong> Up to 3 nodes, 24-hour history, 9 observation patterns, local MCP server, local inline proxy.</li>
      <li><strong>Pro ($9/month):</strong> Up to 10 nodes, 7-day history, 18 observation patterns, Slack and email alerts, custom alert thresholds, fleet proxy metrics, node naming.</li>
      <li><strong>Team ($19/seat/month, 3-seat minimum):</strong> Up to 25 nodes, 90-day history, OpenTelemetry and Prometheus export, Cloud MCP, PagerDuty alerts, shared dashboards.</li>
      <li><strong>Enterprise:</strong> Custom pricing and terms. Contact us for details.</li>
    </ul>
    <p>Pricing is subject to change with 30 days notice to existing subscribers.</p>

    <h2>4. Billing</h2>
    <p>Paid subscriptions are billed monthly through our payment processor, Paddle. By subscribing, you authorize recurring charges. Subscriptions renew automatically unless cancelled before the next billing cycle.</p>

    <h2>5. Data and Sovereignty</h2>
    <p>The Wicklee agent is designed to be sovereign by default:</p>
    <ul>
      <li>The agent runs locally and makes no outbound connections unless you explicitly enable fleet pairing.</li>
      <li>When fleet pairing is enabled, hardware telemetry (CPU, GPU, memory, power, thermal state, inference metrics) is transmitted to wicklee.dev for aggregation.</li>
      <li>We do not collect, store, or transmit your inference prompts, model outputs, or any content processed by your AI models.</li>
      <li>You may unpair from the fleet at any time, immediately stopping all data transmission.</li>
    </ul>

    <h2>6. Acceptable Use</h2>
    <p>You agree not to:</p>
    <ul>
      <li>Reverse engineer, decompile, or disassemble the Service beyond what is permitted by the FSL-1.1-Apache-2.0 license.</li>
      <li>Use the Service to compete with Wicklee by offering a hosted or managed monitoring service based on our software.</li>
      <li>Transmit malicious data or attempt to exploit the Service infrastructure.</li>
      <li>Share API keys or account access with unauthorized parties.</li>
      <li>Exceed published rate limits (600 requests/minute for API access).</li>
    </ul>

    <h2>7. License</h2>
    <p>The Wicklee software is licensed under FSL-1.1-Apache-2.0 (Functional Source License). This means:</p>
    <ul>
      <li>You may use, copy, modify, and redistribute the software for any purpose except competing with Wicklee as a hosted service.</li>
      <li>After four years from each release date, the software converts to Apache 2.0 (fully permissive open source).</li>
    </ul>

    <h2>8. Availability and Support</h2>
    <p>We strive to maintain high availability but do not guarantee specific uptime for the cloud service. The local agent operates independently and is not affected by cloud service availability. Support is provided on a best-effort basis for Community tier and via email for paid tiers.</p>

    <h2>9. Limitation of Liability</h2>
    <p>The Service is provided "as is" without warranty of any kind. We are not liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service. Our total liability is limited to the amount you paid us in the 12 months preceding the claim.</p>

    <h2>10. Termination</h2>
    <p>You may cancel your subscription at any time. We may suspend or terminate your account for violations of these Terms. Upon termination, your access to cloud features will cease, but the local agent will continue to function independently.</p>

    <h2>11. Changes to Terms</h2>
    <p>We may update these Terms from time to time. Material changes will be communicated via email or dashboard notification at least 30 days in advance. Continued use of the Service after changes constitutes acceptance.</p>

    <h2>12. Contact</h2>
    <p>Questions about these Terms? Contact us at <a href="mailto:legal@wicklee.dev">legal@wicklee.dev</a>.</p>
  </>
);

const PrivacyPolicy: React.FC = () => (
  <>
    <h1>Privacy Policy</h1>
    <p>This Privacy Policy explains how Wicklee ("we", "us", "our") collects, uses, and protects your information.</p>

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
      <li><strong>Subscription data:</strong> Billing status, tier, payment history (processed by Paddle; we do not store payment card details).</li>
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
      <li><strong>Local data:</strong> The agent stores up to 1 hour of metrics in a local DuckDB database on your machine. This data never leaves your device unless fleet pairing is enabled.</li>
      <li><strong>Cloud data:</strong> Raw telemetry is retained for 2 days. 5-minute rollups are retained for 90 days. Node events are retained for 30 days.</li>
      <li><strong>Account data:</strong> Retained for the lifetime of your account and deleted within 30 days of account closure.</li>
    </ul>

    <h2>5. Data Sharing</h2>
    <p>We do not sell your data. We share information only with:</p>
    <ul>
      <li><strong>Clerk:</strong> Authentication provider (email, name).</li>
      <li><strong>Paddle:</strong> Payment processor (billing information).</li>
      <li><strong>Railway:</strong> Infrastructure provider (hosting; data is encrypted in transit and at rest).</li>
    </ul>
    <p>We may disclose information if required by law or to protect our rights.</p>

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
    <p>Privacy questions? Contact us at <a href="mailto:privacy@wicklee.dev">privacy@wicklee.dev</a>.</p>
  </>
);

const RefundPolicy: React.FC = () => (
  <>
    <h1>Refund Policy</h1>
    <p>We want you to be satisfied with Wicklee. This policy explains how refunds work for paid subscriptions.</p>

    <h2>1. Free Tier</h2>
    <p>The Community tier is free and requires no payment. No refund applies.</p>

    <h2>2. Pro and Team Subscriptions</h2>

    <h3>14-Day Money-Back Guarantee</h3>
    <p>If you are not satisfied with your paid subscription, you may request a full refund within 14 days of your initial purchase. No questions asked.</p>

    <h3>After 14 Days</h3>
    <p>After the 14-day window, subscriptions are non-refundable for the current billing period. You may cancel at any time, and your access will continue until the end of your current billing cycle.</p>

    <h2>3. Annual Subscriptions</h2>
    <p>If annual billing is offered, the 14-day money-back guarantee applies from the date of purchase. After 14 days, a prorated refund may be issued at our discretion for the unused portion of the annual term.</p>

    <h2>4. Downgrades</h2>
    <p>If you downgrade from a higher tier to a lower tier (e.g., Team to Pro, or Pro to Community), the change takes effect at the end of your current billing cycle. No prorated refund is issued for downgrades.</p>

    <h2>5. Service Issues</h2>
    <p>If the cloud service experiences significant downtime or degradation that materially affects your use, we may issue credits or refunds at our discretion. The local agent is not affected by cloud service availability and continues to function independently.</p>

    <h2>6. How to Request a Refund</h2>
    <p>To request a refund, contact us at <a href="mailto:support@wicklee.dev">support@wicklee.dev</a> with your account email and the reason for your request. Refunds are processed through Paddle and typically appear within 5-10 business days.</p>

    <h2>7. Enterprise</h2>
    <p>Enterprise contracts have separate terms. Refund policies for Enterprise customers are governed by the individual agreement.</p>
  </>
);

export default LegalPage;
