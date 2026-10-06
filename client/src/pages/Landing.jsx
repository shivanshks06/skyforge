import Navbar from "../components/Navbar";
import Card from "../components/Card";
import { Link } from "react-router-dom";
import { 
  Sparkles, 
  ArrowRight, 
  Cloud,
  GitBranch,
  Zap,
  Activity, 
} from "lucide-react";

export default function Landing() {
  const features = [
    {
      icon: Zap,
      title: "AI Infrastructure Generation",
      description: "Describe your app setup in plain English. SkyForge generates optimized Docker, Terraform & AWS manifests.",
      color: "text-[#9E5D2D] bg-[#9E5D2D]/10 border-[#9E5D2D]/20"
    },
    {
      icon: Cloud,
      title: "Direct AWS Deployment",
      description: "Deploy seamlessly into your own AWS account using secure role assumptions without vendor lock-in.",
      color: "text-[#2A6668] bg-[#2A6668]/10 border-[#2A6668]/20"
    },
    {
      icon: GitBranch,
      title: "GitHub Automation",
      description: "Connect your repositories. SkyForge builds, verifies, and deploys the project you select.",
      color: "text-[#767E56] bg-[#767E56]/10 border-[#767E56]/20"
    },
    {
      icon: Activity,
      title: "Real-time Telemetry",
      description: "Monitor deployment logs, server health metrics, and active container instances from one unified panel.",
      color: "text-[#3B7A75] bg-[#3B7A75]/10 border-[#3B7A75]/20"
    }
  ];

  return (
    <div className="app-bg relative min-h-screen bg-[#FAF8F5] text-[#362217] selection:bg-[#9E5D2D]/20 selection:text-[#362217]">
      {/* Soft Ambient Background Lights (matching screenshot glows) */}
      <div className="ambient-glow-teal top-0 right-1/4" />
      <div className="ambient-glow-bronze top-10 right-0" />

      {/* Grid Pattern Overlay */}
      <div className="absolute inset-0 bg-grid-pattern opacity-60" />

      <div className="relative z-10">
        <Navbar />

        {/* Hero Section */}
        <section className="w-full flex flex-col items-center px-6 sm:px-12 md:px-16 pt-24 pb-20 text-center">
          {/* Release Badge */}
          <div className="mb-6 inline-flex items-center gap-2.5 rounded-full border border-[#4D3325] bg-[#362217] px-4.5 py-2 shadow-sm">
            <Sparkles className="h-4.5 w-4.5 text-[#E8C39E] animate-pulse" />
            <span className="text-sm font-semibold text-[#E8C39E]">SkyForge v1.0 is Live</span>
          </div>

          {/* Hero Headline */}
          <h1 className="max-w-6xl text-5xl font-extrabold tracking-tight text-[#362217] sm:text-7xl lg:text-8xl">
            Deploy to your cloud with{" "}
            <span className="bg-gradient-to-r from-[#2A6668] via-[#3B7A75] to-[#767E56] bg-clip-text text-transparent">
              AI-Powered Precision.
            </span>
          </h1>

          <p className="mt-6 max-w-3xl text-xl text-[#5E4C3E] sm:text-2xl leading-relaxed">
            Connect GitHub. Let SkyForge analyze code, synthesize infrastructure, and deploy directly into your cloud in seconds.
          </p>

          {/* CTA Group */}
          <div className="mt-10 flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
            <Link
              to="/signup"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[#8B5024] bg-[#9E5D2D] px-8 py-2.5 text-lg font-medium text-white shadow-md transition hover:bg-[#8B5024] sm:w-auto"
            >
              Start Deploying Free <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="#features"
              className="inline-flex w-full items-center justify-center rounded-xl border-2 border-[#362217] bg-white px-8 py-2.5 text-lg font-semibold text-[#362217] transition hover:bg-[#F4EFEA] sm:w-auto"
            >
              &gt;_ Explore Platform
            </a>
          </div>

          <div className="mt-16 grid w-full max-w-6xl grid-cols-1 gap-4 text-left md:grid-cols-3">
            {[
              ["01", "Connect a repository", "Choose a GitHub repository and branch. SkyForge reads the project metadata needed to plan a deployment."],
              ["02", "Review the generated plan", "Inspect the detected runtime, Docker strategy, AWS target, environment variables, and estimated cost."],
              ["03", "Deploy into your AWS account", "Verify your AWS connection, start the deployment, and follow the real build, rollout, and health-check logs."],
            ].map(([number, title, description]) => (
              <div key={number} className="rounded-2xl border border-[#DCD0C3] bg-white p-6 shadow-lg shadow-[#362217]/5">
                <span className="font-mono text-sm font-bold text-[#9E5D2D]">{number}</span>
                <h3 className="mt-3 text-xl font-bold text-[#362217]">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#5E4C3E]">{description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Features Section */}
        <section id="features" className="w-full px-6 sm:px-12 md:px-16 py-24 border-t border-[#EADFCF]">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-extrabold tracking-tight sm:text-5xl text-[#362217]">
              Built for Modern Cloud Engineering
            </h2>
            <p className="mt-4 text-[#5E4C3E] text-base sm:text-lg max-w-2xl mx-auto leading-relaxed">
              Everything you need to automate infrastructure provisioning, container deployments, and environment health.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 w-full">
            {features.map((feat, idx) => (
              <Card key={idx} glow={false} className="flex flex-col gap-4 p-7 bg-white border border-[#EAE1D5]">
                <div className={`p-3.5 rounded-xl border w-fit ${feat.color}`}>
                  <feat.icon className="h-7 w-7" />
                </div>
                <h3 className="text-2xl font-bold text-[#362217]">{feat.title}</h3>
                <p className="text-base text-[#5E4C3E] leading-relaxed">{feat.description}</p>
              </Card>
            ))}
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-[#EADFCF] bg-[#F4EFEA] py-8 text-center text-sm text-[#786658]">
          <div className="w-full px-6 sm:px-12 flex flex-col sm:flex-row items-center justify-between gap-4">
            <span>© 2026 SkyForge Inc. All rights reserved.</span>
            <div className="flex gap-6">
              <span className="text-[#8C7667]">Privacy documentation available on request</span>
              <span className="text-[#8C7667]">Usage terms available on request</span>
              <span className="text-[#8C7667]">See the project README for documentation</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
