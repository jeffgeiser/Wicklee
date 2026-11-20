import React, { useState, useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { CONTACT_EMAIL, PRIVACY_EMAIL, mailto } from './utils/contact';

type LegalTab = 'terms' | 'privacy';

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
        </div>
        <p className="text-xs text-gray-600 mt-12">Last updated: November 20, 2026</p>
      </div>
    </div>
  );
};

const TermsOfService: React.FC = () => (
  <>
    <h1>Terms of Service</h1>
    <p>These Terms of Service ("Terms") govern your use of Wicklee ("Service"). Wicklee is a product of Noorth Labs ("Noorth Labs", "we", "us", "our"). By using the Service, you agree to these Terms.</p>

    <h2>1. Service Description</h2>
    <p>Wicklee provides evidence-based diagnostics, model readiness and performance verification for self-hosted AI inference. The Service consists of:</p>
    <ul>
      <li><strong>Agent:</strong> A local binary you install on your own machine. It reads hardware and inference-runtime state, serves a local dashboard and command-line interface, and keeps its data on your device. It makes no outbound connections to Noorth Labs.</li>
      <li><strong>Website:</strong> The static site at wicklee.dev, which carries documentation, the blog, the install scripts and the agent releases' download links. It has no accounts and no API.</li>
    </ul>
    <p>Wicklee does not operate a hosted service, fleet backend or account system.</p>

    <h2>2. Charges</h2>
    <p>The Service is offered at no charge. There are no paid plans and no payment is taken.</p>

    <h2>3. Data and Sovereignty</h2>
    <ul>
      <li>The agent runs locally. Everything it measures stays on your machine.</li>
      <li>We do not collect, store, or transmit your inference prompts, model outputs, or any content processed by your AI models.</li>
      <li>If you bind the agent to a non-loopback address, you are responsible for the network exposure and for the access token it requires.</li>
    </ul>

    <h2>4. Acceptable Use</h2>
    <p>You agree not to:</p>
    <ul>
      <li>Reverse engineer, decompile, or disassemble the Service beyond what is permitted by the licences described in <a href="https://github.com/jeffgeiser/wicklee/blob/main/LICENSING.md">LICENSING.md</a>.</li>
      <li>Use the website code to offer a competing product or service, as the FSL-1.1-Apache-2.0 licence that covers it provides.</li>
      <li>Use the Service to attack, disrupt or gain unauthorised access to any system.</li>
    </ul>

    <h2>5. License</h2>
    <p>The licences are split by directory, as described in LICENSING.md:</p>
    <ul>
      <li>The agent and the local dashboard are licensed under the Apache License 2.0.</li>
      <li>The website source in <code>src/site/</code> is licensed under FSL-1.1-Apache-2.0 (Functional Source License). Each release converts to Apache 2.0 four years after it is published.</li>
    </ul>

    <h2>6. Availability and Support</h2>
    <p>The agent operates independently and does not depend on any service we run. The website is provided on a best-effort basis. Support is provided on a best-effort basis via GitHub issues.</p>

    <h2>7. Limitation of Liability</h2>
    <p>The Service is provided "as is" without warranty of any kind. We are not liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service. Our total liability is limited to the amount you paid for the Service in the 12 months preceding the claim, which is zero.</p>

    <h2>8. Governing Law and Disputes</h2>
    <p>These Terms are governed by the laws of the Commonwealth of Virginia, United States, without regard to its conflict-of-law rules. Any dispute arising out of or relating to these Terms or the Service will be brought exclusively in the state or federal courts located in the Commonwealth of Virginia, and you and we consent to the personal jurisdiction of those courts. Nothing in this section limits any mandatory consumer protection rights you have under the law of the country where you live.</p>

    <h2>9. Changes to Terms</h2>
    <p>We may update these Terms from time to time. Changes will be posted on this page with an updated date. Continued use of the Service after changes constitutes acceptance.</p>

    <h2>10. Contact</h2>
    <p>Questions about these Terms? Contact Noorth Labs at <a href={mailto(CONTACT_EMAIL)}>{CONTACT_EMAIL}</a>.</p>
  </>
);

const PrivacyPolicy: React.FC = () => (
  <>
    <h1>Privacy Policy</h1>
    <p>This Privacy Policy explains how Noorth Labs ("we", "us", "our"), which makes Wicklee, handles information.</p>

    <h2>1. Our Privacy Principle</h2>
    <p>Wicklee is built on a principle of structural privacy. The agent runs entirely on your machine and sends nothing to us. There is no hosted service to send it to.</p>

    <h2>2. Information We Collect</h2>

    <h3>The agent:</h3>
    <p>We collect nothing. The agent operates on your device, and no telemetry, hardware data, model names or inference metrics leave it. The agent's only network activity is talking to inference runtimes you run yourself (such as Ollama or vLLM) on your own machine, and answering requests you make to it.</p>

    <h3>The website:</h3>
    <p>wicklee.dev is a static site. We do not run accounts or collect form submissions. Cloudflare, which delivers the site, processes standard request data (such as IP address) to serve pages and to provide privacy-friendly page-view analytics.</p>

    <h3>What we never collect:</h3>
    <ul>
      <li>Your prompts, model inputs, or inference outputs.</li>
      <li>File contents on your machine.</li>
      <li>Hardware or inference telemetry from your agent.</li>
      <li>Personal data from your local network.</li>
    </ul>

    <h2>3. Data Storage and Retention</h2>
    <ul>
      <li><strong>Local data:</strong> The agent stores metrics in a local DuckDB database on your machine: 1-second samples for 24 hours, 1-minute aggregates for 30 days, and 1-hour aggregates for 90 days. It is yours; delete the file to remove it.</li>
      <li><strong>Email:</strong> If you write to us, we keep the correspondence for as long as needed to answer you.</li>
    </ul>

    <h2>4. Service Providers</h2>
    <p>We do not sell your data. wicklee.dev uses:</p>
    <ul>
      <li><strong>Cloudflare:</strong> Website delivery, email routing for our wicklee.dev addresses, and privacy-friendly page-view analytics.</li>
      <li><strong>GitHub:</strong> Hosting of the source code and the agent release downloads.</li>
      <li><strong>Google Fonts:</strong> Web fonts loaded by wicklee.dev pages (your browser requests the fonts, which shares your IP address with Google).</li>
    </ul>
    <p>We may disclose information if required by law or to protect our rights.</p>

    <h2>5. Security</h2>
    <ul>
      <li>The agent configuration file is written with restricted permissions (0600).</li>
      <li>The agent binds to localhost by default; LAN access is opt-in and requires a bearer token.</li>
    </ul>

    <h2>6. Cookies</h2>
    <p>wicklee.dev does not set cookies of its own. We use Cloudflare analytics for basic page view metrics. We do not use advertising or tracking cookies.</p>

    <h2>7. Children</h2>
    <p>The Service is not directed at children under 16. We do not knowingly collect information from children.</p>

    <h2>8. Changes</h2>
    <p>We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated date.</p>

    <h2>9. Contact</h2>
    <p>Privacy questions? Contact Noorth Labs at <a href={mailto(PRIVACY_EMAIL)}>{PRIVACY_EMAIL}</a>.</p>
  </>
);

export default LegalPage;
