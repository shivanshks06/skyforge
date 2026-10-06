import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AlertTriangle, BookOpen, CheckCircle2, ChevronRight, Info, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import Card from "../components/Card";
import Button from "../components/Button";
import { getAwsReadiness } from "../services/api";
import { AWS_GUIDE_SECTIONS } from "../data/awsGuideSections";


const STATUS = {
  pass: { icon: CheckCircle2, style: "text-[#2E6B4F]", label: "Ready" },
  warn: { icon: AlertTriangle, style: "text-amber-600", label: "Attention" },
  fail: { icon: XCircle, style: "text-[#9E2A2B]", label: "Blocking" },
  info: { icon: Info, style: "text-[#3B7A75]", label: "Info" },
};

function Section({ id, title, children }) {
  return (
    <Card glow={false} id={id} className="scroll-mt-24 bg-white border border-[#EAE1D5] flex flex-col gap-3">
      <h2 className="text-base font-bold text-[#362217]">{title}</h2>
      <div className="flex flex-col gap-3 text-sm text-[#5E4C3E] leading-relaxed">{children}</div>
    </Card>
  );
}

function Steps({ items }) {
  return (
    <ol className="list-decimal pl-5 flex flex-col gap-1.5">
      {items.map((item) => <li key={typeof item === "string" ? item : item.key}>{item}</li>)}
    </ol>
  );
}

function Table({ head, rows }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#EAE1D5]">
      <table className="w-full text-left text-xs">
        <thead className="bg-[#FAF8F5] text-[#362217]"><tr>{head.map((cell) => <th key={cell} className="p-2.5 font-semibold">{cell}</th>)}</tr></thead>
        <tbody className="divide-y divide-[#F0E7DC]">
          {rows.map((row) => <tr key={row[0]}>{row.map((cell, index) => <td key={index} className="p-2.5 align-top">{cell}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

const Code = ({ children }) => <code className="rounded bg-[#FAF8F5] border border-[#EAE1D5] px-1.5 py-0.5 font-mono text-[12px] text-[#362217]">{children}</code>;

function ReadinessPanel() {
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await getAwsReadiness());
    } catch (err) {
      setError(err.response?.data?.message || "The check could not run.");
    } finally {
      setRunning(false);
    }
  };

  const groups = result ? [...new Set(result.checks.map((check) => check.group))] : [];
  return (
    <Card glow={false} id="check" className="scroll-mt-24 bg-white border border-[#EAE1D5] flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-[#362217] flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-[#9E5D2D]" /> Check my AWS account</h2>
          <p className="text-xs text-[#5E4C3E]">Read-only checks of your connected AWS account and this computer. Nothing is created or billed.</p>
        </div>
        <Button icon={RefreshCw} loading={running} onClick={run}>{result ? "Check again" : "Run checks"}</Button>
      </div>
      {error && <p className="text-xs text-[#9E2A2B]">{error}</p>}
      {result && (
        <>
          <div className={`rounded-xl border p-3 text-sm font-semibold ${result.summary.ready ? "border-[#2E6B4F]/30 bg-[#2E6B4F]/10 text-[#2E6B4F]" : "border-[#9E2A2B]/30 bg-[#9E2A2B]/10 text-[#9E2A2B]"}`}>
            {result.summary.ready ? "Ready to deploy" : "Not ready yet: fix the blocking items below"}
            <span className="ml-2 text-xs font-normal">
              {result.summary.pass} ready · {result.summary.warn} need attention · {result.summary.fail} blocking
              {result.account ? ` · account ${result.account} · ${result.region}` : ""}
            </span>
          </div>
          {groups.map((group) => (
            <div key={group} className="flex flex-col gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wide text-[#8C7667]">{group}</span>
              <ul className="flex flex-col divide-y divide-[#F0E7DC] rounded-xl border border-[#EAE1D5]">
                {result.checks.filter((check) => check.group === group).map((check) => {
                  const status = STATUS[check.status] || STATUS.info;
                  const Icon = status.icon;
                  return (
                    <li key={check.id} className="p-3 flex gap-3">
                      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${status.style}`} />
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm font-semibold text-[#362217]">{check.label} <span className={`text-[10px] font-bold uppercase ${status.style}`}>{status.label}</span></span>
                        <span className="text-xs text-[#5E4C3E] break-words">{check.detail}</span>
                        {check.fix && check.status !== "pass" && <span className="text-xs text-[#9E5D2D]"><strong>How to fix:</strong> {check.fix}</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

export default function AwsGuide() {
  const location = useLocation();
  useEffect(() => {
    // Search results link to #section ids; scroll there once the page has rendered.
    if (!location.hash) return undefined;
    const task = window.setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    return () => window.clearTimeout(task);
  }, [location.hash]);

  return (
    <div className="flex flex-col gap-6 pb-16 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-[#362217] flex items-center gap-2"><BookOpen className="h-6 w-6 text-[#9E5D2D]" /> AWS guide</h1>
        <p className="text-sm text-[#5E4C3E]">Everything your AWS account needs before SkyForge can deploy: sign-up, verification, security, limits, costs and fixes for common errors.</p>
      </div>

      <Card glow={false} className="bg-white border border-[#EAE1D5]">
        <nav aria-label="Guide contents" className="grid grid-cols-1 sm:grid-cols-2 gap-1">
          {AWS_GUIDE_SECTIONS.map((section) => (
            <a key={section.id} href={`#${section.id}`} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-[#5E4C3E] hover:bg-[#FAF6F0] hover:text-[#362217]">
              <ChevronRight className="h-3.5 w-3.5 text-[#9E5D2D]" /> {section.title}
            </a>
          ))}
        </nav>
      </Card>

      <ReadinessPanel />

      <Section id="account" title="1. Create and verify your AWS account">
        <p>Go to <strong>aws.amazon.com → Create an AWS account</strong>. AWS verifies four things before the account can launch anything:</p>
        <Table
          head={["Verification", "What AWS asks for", "Notes"]}
          rows={[
            ["Email", "A code sent to the root email address", "Use an address you will keep; it owns the account."],
            ["Payment method", "A credit or debit card (or UPI/net banking for AWS India accounts)", "AWS makes a small temporary authorisation (about $1 or ₹2) to check the card. International transactions must be enabled on the card."],
            ["Phone", "A code by SMS or voice call", "Needed even on the free plan."],
            ["Identity / address", "Billing address; Indian accounts (AISPL) may ask for PAN and GST details", "Use the details that match the card."],
          ]}
        />
        <p>Choose the <strong>Basic (free) support plan</strong>. Activation usually takes minutes, but can take up to 24 hours; until then services return <Code>SubscriptionRequiredException</Code> or <Code>OptInRequired</Code>.</p>
        <p>New accounts also get extra checks on some services (CloudFront, CodeBuild, sometimes Fargate). See <a href="#verifications" className="text-[#9E5D2D] font-semibold hover:underline">section 5</a>.</p>
      </Section>

      <Section id="security" title="2. Secure the account (root, MFA, IAM)">
        <Steps items={[
          <span key="mfa">Turn on <strong>MFA for the root user</strong>: account menu → Security credentials → Assign MFA device (authenticator app or passkey).</span>,
          <span key="root">Do <strong>not</strong> create or use root access keys. If you already did, connect SkyForge with an IAM role or IAM user instead (step 3) and then delete the root keys under Security credentials.</span>,
          <span key="iam">Use <strong>IAM Identity Center</strong> or an <strong>IAM user with MFA</strong> for your own console sign-in.</span>,
          <span key="least">Give SkyForge only what it needs: the CloudFormation template in Settings creates a role with exactly SkyForge's permissions.</span>,
        ]}
        />
        <p className="text-xs text-[#8C7667]">The account check above warns when SkyForge is connected with root keys.</p>
      </Section>

      <Section id="connect" title="3. Connect AWS to SkyForge">
        <Table
          head={["Method", "How", "When to use"]}
          rows={[
            ["IAM role (recommended)", <span key="role">Settings → AWS Cloud Connection → <strong>IAM role</strong> → download the CloudFormation template → AWS console → CloudFormation → Create stack → upload it → copy the role ARN back into SkyForge. The role trusts only SkyForge's account and requires a unique External ID.</span>, "Production, shared machines, anything long-lived"],
            ["Access keys", <span key="keys">IAM → Users → Create user → attach the SkyForge policy (or the permissions listed in the README) → Security credentials → Create access key (\"Application running outside AWS\") → paste both values into Settings. Keys are verified with STS and stored encrypted.</span>, "Quick local testing"],
          ]}
        />
        <p>After upgrading SkyForge, re-create the role from the newest template: new features (managed databases, cloud builds, quota checks) need new permissions. The account check lists anything that is missing.</p>
      </Section>

      <Section id="region" title="4. Choose a region">
        <p>Pick the region closest to your visitors; SkyForge creates everything (ECS, load balancer, database, firewall) there. <Code>ap-south-1</Code> (Mumbai) suits India.</p>
        <p>Two things always live in <Code>us-east-1</Code> no matter which region you choose: CloudFront distributions and the CloudFront firewall. You do not need to do anything for that.</p>
        <p>Your computer must be able to reach the region: if deploys fail with <Code>connect ETIMEDOUT</Code> to a <Code>13.x.x.x</Code> address, run the account check: the network row shows whether the region is reachable.</p>
      </Section>

      <Section id="verifications" title="5. Account verifications and limits">
        <p>New AWS accounts start with some services restricted. SkyForge keeps working without them, but these unlock HTTPS, faster builds and bigger apps:</p>
        <Table
          head={["What", "Symptom in SkyForge", "How to unlock"]}
          rows={[
            ["CloudFront (free HTTPS)", <span key="cf">\"Your account must be verified before you can add new CloudFront resources\"; CloudFront targets fall back to HTTP</span>, <span key="cff">AWS console → <strong>Support → Create case → Account and billing</strong> → ask for <em>account verification for CloudFront</em>. Mention you need to create distributions. Usually 1–3 days.</span>],
            ["CodeBuild (cloud builds)", <span key="cb">\"Cannot have more than 0 builds in queue for the account\"; SkyForge builds on this computer instead</span>, <span key="cbf"><strong>Service Quotas → AWS CodeBuild → Concurrently running builds (Linux/Medium)</strong> → Request increase to 5. If not adjustable, open a Support case.</span>],
            ["Fargate vCPU", <span key="fg">\"You've reached the limit on the number of vCPUs\"; tasks stay PENDING</span>, <span key="fgf"><strong>Service Quotas → AWS Fargate → Fargate On-Demand vCPU resource count</strong> → Request increase.</span>],
            ["RDS databases", <span key="rd">\"InstanceQuotaExceeded\" when creating a managed database</span>, <span key="rdf"><strong>Service Quotas → Amazon RDS → DB instances</strong>, or destroy unused projects.</span>],
            ["Load balancers / security groups", "Rare: limits on ALBs (50) or security groups per VPC (2,500)", "Destroy unused projects, or request an increase in Service Quotas."],
          ]}
        />
        <p>Microphone, camera and location in the browser need <strong>HTTPS</strong>. Until CloudFront is enabled, apps that use them work only partly on SkyForge's HTTP address.</p>
      </Section>

      <Section id="billing" title="6. Billing safety: budgets and free tier">
        <Steps items={[
          <span key="budget"><strong>Billing → Budgets → Create budget → Monthly cost budget</strong> with an email alert at 80% (e.g. $20). This is the most important safety net.</span>,
          <span key="ft"><strong>Billing → Free Tier</strong> shows what is still free. Accounts created after 15 July 2025 get credits and a free plan instead of the older 12-month free tier; check which applies to you.</span>,
          <span key="explorer">Enable <strong>Cost Explorer</strong> to see costs per service the next day.</span>,
          <span key="wallet">In SkyForge, set a monthly budget on a project's Security page (denial-of-wallet guard): it warns and can take the site offline if traffic makes costs run away.</span>,
        ]}
        />
      </Section>

      <Section id="checklist" title="7. Pre-deployment checklist">
        <ul className="flex flex-col gap-1.5">
          {[
            "AWS account activated (email, card, phone verified) and region chosen",
            "SkyForge connected with an IAM role or IAM user, not root keys (Settings)",
            "\"Check my AWS account\" above shows no blocking items",
            "Docker Desktop running (local builds and static sites)",
            "GitHub connected (private repositories, fix pull requests, higher API limit)",
            "Project imported, framework/branch/port detected or set",
            "Deployment target chosen on the Infrastructure page (ECS Fargate, ECS + CloudFront, or S3 + CloudFront)",
            "Environment variables set; none of them point to localhost",
            "Database chosen: your own URL, or a SkyForge-managed RDS database",
            "Security tier chosen (Free or Protected) and an alert channel configured (Settings)",
            "A monthly AWS budget alert exists (section 6)",
          ].map((item) => (
            <li key={item} className="flex items-start gap-2"><CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-[#2E6B4F]" /> {item}</li>
          ))}
        </ul>
        <p>SkyForge also runs its own preflight on every deploy and blocks it with a clear message if something required is missing.</p>
      </Section>

      <Section id="errors" title="8. Common errors and fixes">
        <Table
          head={["Error message", "Meaning", "Fix"]}
          rows={[
            ["Your account must be verified before you can add new CloudFront resources", "CloudFront not enabled for new accounts", "Support case \"Account verification for CloudFront\" (section 5). The site works over HTTP meanwhile."],
            ["Cannot have more than 0 builds in queue for the account", "CodeBuild limit is 0", "Request a CodeBuild quota increase. SkyForge falls back to a local build automatically."],
            ["connect ETIMEDOUT 13.x.x.x:443", "This computer cannot reach the AWS region", "Switch network, toggle VPN, check firewall/antivirus. Run the account check."],
            ["AccessDenied / is not authorized to perform", "The connected role/user lacks a permission", "Re-create the role from the latest template in Settings."],
            ["timeout awaiting response headers / push stalled", "Slow or unstable upload to ECR", "SkyForge retries automatically; use a faster network or cloud builds."],
            ["You've reached the limit on the number of vCPUs", "Fargate vCPU quota too low", "Service Quotas → Fargate On-Demand vCPU resource count."],
            ["No default VPC / at least two subnets are required", "The region has no default network", "VPC console → Actions → Create default VPC."],
            ["toomanyrequests: You have reached your pull rate limit", "Docker Hub download limit", "Wait an hour, sign in to Docker Hub in Docker Desktop, or use cloud builds (they use Amazon's mirror)."],
            ["SubscriptionRequiredException / OptInRequired", "The account is not fully activated yet", "Finish account verification (section 1); wait up to 24 hours."],
          ]}
        />
      </Section>

      <Section id="costs" title="9. What each target costs">
        <Table
          head={["Item", "Approximate monthly cost", "Notes"]}
          rows={[
            ["ECS Fargate (0.5 vCPU, 1 GB) + load balancer", "$25–35", "The load balancer is about $16 of this."],
            ["ECS Fargate + CloudFront", "Same + a few cents", "CloudFront is pay-per-use."],
            ["S3 + CloudFront static site", "Under $1", "Storage and requests only."],
            ["Managed RDS database (db.t4g.micro, 20 GB)", "$13–16", "Free-tier eligible on some accounts."],
            ["Protected tier (AWS WAF)", "$14–20", "$5 per firewall + $1 per rule + $0.60 per million requests."],
            ["Cloud builds (CodeBuild)", "~$0.01 per build minute", "First 100 minutes a month are free."],
          ]}
        />
        <p>Each project's Security page shows a cost projection from its real traffic.</p>
      </Section>

      <Section id="cleanup" title="10. Stopping charges and cleaning up">
        <Steps items={[
          <span key="offline"><strong>Take site offline</strong> (Security page) stops the container but keeps the load balancer and database billing.</span>,
          <span key="destroy"><strong>One-Click Destroy</strong> (Deployment console) deletes everything for the project, including its database and firewall, and verifies with AWS that nothing is left.</span>,
          <span key="shared">Shared, account-level items cost nothing while idle: the cloud-build bucket (files expire after a day), its IAM role and the CodeBuild project.</span>,
          <span key="close">To close the AWS account: destroy all projects first, then Account → Close account.</span>,
        ]}
        />
        <p className="text-xs">Need help with your projects? <Link to="/dashboard/projects" className="text-[#9E5D2D] font-semibold hover:underline">Go to Projects</Link>.</p>
      </Section>
    </div>
  );
}
