import { useState, useEffect, useContext } from "react";
import { AuthContext } from "../context/authContext.js";
import Card from "../components/Card";
import Button from "../components/Button";
import Input from "../components/Input";
import {
  User,
  Mail,
  Key,
  Save,
  Check,
  GitPullRequest,
  CheckCircle2,
  RefreshCw,
  Unlink,
  Cloud,
  ShieldCheck,
  Copy,
  Download,
  ExternalLink,
  AlertCircle,
  Eye,
  EyeOff,
  Lock,
  Edit2,
} from "lucide-react";
import {
  disconnectGithub,
  getGithubLoginUrl,
  getAwsStatus,
  initiateAwsSetup,
  connectAwsRole,
  saveAwsCredentials,
  disconnectAws,
  updateProfile,
} from "../services/api";

export default function Settings() {
  const { user, setUser, isGithubConnected, githubAccount, refreshUser } = useContext(AuthContext);
  const [name, setName] = useState(user?.name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [saved, setSaved] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // AWS Wizard States
  const [awsLoading, setAwsLoading] = useState(true);
  const [awsConnected, setAwsConnected] = useState(false);
  const [awsData, setAwsData] = useState(null);
  const [activeAwsTab, setActiveAwsTab] = useState("role"); // "keys" | "role"
  const [accessKeyIdInput, setAccessKeyIdInput] = useState("");
  const [secretAccessKeyInput, setSecretAccessKeyInput] = useState("");
  const [sessionTokenInput, setSessionTokenInput] = useState("");
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [isEditingKeys, setIsEditingKeys] = useState(false);
  const [roleArnInput, setRoleArnInput] = useState("");
  const [regionInput, setRegionInput] = useState("ap-south-1");
  const [copiedExternalId, setCopiedExternalId] = useState(false);
  const [verifyingAws, setVerifyingAws] = useState(false);
  const [disconnectingAws, setDisconnectingAws] = useState(false);
  const [awsNotice, setAwsNotice] = useState(null);

  const loadAwsStatus = async () => {
    try {
      setAwsLoading(true);
      const res = await getAwsStatus();
      setAwsData(res);
      setAwsConnected(res.connected);
      if (res.roleArn) setRoleArnInput(res.roleArn);
      if (res.region) setRegionInput(res.region);
      if (res.authType === "ACCESS_KEYS" || res.hasAccessKeys) {
        setActiveAwsTab("keys");
      }
    } catch (err) {
      console.error("Failed to load AWS status:", err);
    } finally {
      setAwsLoading(false);
    }
  };

  useEffect(() => {
    if (user) {
      queueMicrotask(() => {
        setName(user.name || "");
        setEmail(user.email || "");
      });
    }
    const task = window.setTimeout(() => void loadAwsStatus(), 0);
    return () => window.clearTimeout(task);
  }, [user]);

  const handleCopyExternalId = () => {
    if (awsData?.externalId) {
      navigator.clipboard.writeText(awsData.externalId);
      setCopiedExternalId(true);
      setTimeout(() => setCopiedExternalId(false), 2000);
    }
  };

  const handleDownloadCloudFormation = async () => {
    try {
      const res = await initiateAwsSetup(regionInput);
      setAwsData((prev) => ({ ...prev, region: res.region, cloudFormationLaunchUrl: res.launchUrl }));
      const blob = new Blob([JSON.stringify(res.template, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "skyforge-deployment-role-template.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download template failed:", err);
      setAwsNotice({ type: "error", message: err.response?.data?.message || "Unable to generate the CloudFormation template." });
    }
  };

  const handleSaveAccessKeys = async (e) => {
    e.preventDefault();
    if (!accessKeyIdInput.trim() || !secretAccessKeyInput.trim()) {
      setAwsNotice({
        type: "error",
        message: "Please enter both your AWS Access Key ID and Secret Access Key.",
      });
      return;
    }

    setVerifyingAws(true);
    setAwsNotice(null);
    try {
      const connection = await saveAwsCredentials({
        accessKeyId: accessKeyIdInput.trim(),
        secretAccessKey: secretAccessKeyInput.trim(),
        sessionToken: sessionTokenInput.trim() || undefined,
        region: regionInput,
      });
      setAwsConnected(true);
      setAwsData((prev) => ({ ...prev, ...connection }));
      setAccessKeyIdInput("");
      setSecretAccessKeyInput("");
      setSessionTokenInput("");
      setIsEditingKeys(false);
      setAwsNotice({
        type: "success",
        message: `Successfully verified and connected AWS Account: ${connection.accountId || "Unknown"} (${connection.region}).`,
      });
    } catch (err) {
      setAwsNotice({
        type: "error",
        message: err.response?.data?.message || err.message || "Failed to verify AWS credentials.",
      });
    } finally {
      setVerifyingAws(false);
    }
  };

  const handleConnectAws = async (e) => {
    e.preventDefault();
    if (!roleArnInput.trim()) return;

    setVerifyingAws(true);
    setAwsNotice(null);
    try {
      const connection = await connectAwsRole({
        roleArn: roleArnInput.trim(),
        region: regionInput,
      });
      setAwsConnected(true);
      setAwsData((prev) => ({ ...prev, ...connection }));
      setAwsNotice({
        type: "success",
        message: `Successfully connected to AWS Account: ${connection.accountId || "Verified"}`,
      });
    } catch (err) {
      setAwsNotice({
        type: "error",
        message: err.response?.data?.message || err.message || "Failed to verify AWS role.",
      });
    } finally {
      setVerifyingAws(false);
    }
  };

  const handleDisconnectAws = async () => {
    if (!confirm("Are you sure you want to disconnect your AWS account?")) return;
    setDisconnectingAws(true);
    try {
      await disconnectAws();
      setAwsConnected(false);
      setAwsData(null);
      setRoleArnInput("");
      setAccessKeyIdInput("");
      setSecretAccessKeyInput("");
      setSessionTokenInput("");
      setIsEditingKeys(false);
      await loadAwsStatus();
      setAwsNotice({
        type: "info",
        message: "AWS account disconnected. Stored credentials wiped securely.",
      });
    } catch (err) {
      console.error("Disconnect error:", err);
      setAwsNotice({ type: "error", message: err.response?.data?.message || "Unable to disconnect the AWS account." });
    } finally {
      setDisconnectingAws(false);
    }
  };

  const handleProfileSave = async (e) => {
    e.preventDefault();
    try {
      const result = await updateProfile({ name, email });
      setUser(result.user);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (saveError) {
      setAwsNotice({ type: "error", message: saveError.response?.data?.message || "Unable to update profile." });
    }
  };

  const handleConnectGitHub = async () => {
    try {
      window.location.assign(await getGithubLoginUrl());
    } catch (error) {
      setAwsNotice({ type: "error", message: error.response?.data?.message || "Unable to start GitHub authorization." });
    }
  };

  const handleDisconnectGitHub = async () => {
    if (!confirm("Are you sure you want to disconnect your GitHub account?")) return;
    setDisconnecting(true);
    try {
      await disconnectGithub();
      await refreshUser();
    } catch (err) {
      console.error("Disconnect error:", err);
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 w-full max-w-4xl text-[#362217] pb-16">
      {/* Page Header */}
      <div>
        <h2 className="text-2xl font-bold text-[#362217]">Account & Cloud Settings</h2>
        <p className="text-xs text-[#5E4C3E] mt-1">
          Manage profile parameters, GitHub integrations, and AWS STS cross-account connections.
        </p>
      </div>

      {saved && (
        <div className="flex items-center gap-3 rounded-2xl border border-[#2E6B4F]/30 bg-[#2E6B4F]/10 p-4 text-xs text-[#2E6B4F] font-semibold">
          <Check className="h-4 w-4 shrink-0" />
          <span>Profile updated successfully!</span>
        </div>
      )}

      {/* Sprint 8: AWS Connection Wizard Card */}
      <Card glow={false} className="flex flex-col gap-5 bg-white border border-[#EAE1D5]">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#EADFCF] pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-[#9E5D2D]/10 text-[#9E5D2D] border border-[#9E5D2D]/20">
              <Cloud className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-[#362217]">AWS Cloud Connection</h3>
              <p className="text-xs text-[#5E4C3E]">
                Connect your AWS account via IAM Access Keys or cross-account IAM Role.
              </p>
            </div>
          </div>

          {awsConnected && (
            <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#2E6B4F]/10 text-[#2E6B4F] border border-[#2E6B4F]/30 text-xs font-semibold">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>AWS Connected</span>
            </span>
          )}
        </div>

        {awsNotice && (
          <div
            className={`p-3.5 rounded-xl border text-xs font-semibold flex items-center gap-2.5 ${
              awsNotice.type === "success"
                ? "bg-[#2E6B4F]/10 text-[#2E6B4F] border-[#2E6B4F]/20"
                : awsNotice.type === "error"
                ? "bg-[#9E2A2B]/10 text-[#9E2A2B] border-[#9E2A2B]/20"
                : "bg-[#FAF6F0] text-[#5E4C3E] border-[#EADFCF]"
            }`}
          >
            {awsNotice.type === "success" ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 shrink-0" />
            )}
            <span>{awsNotice.message}</span>
          </div>
        )}

        {awsLoading ? (
          <div className="flex items-center justify-center py-8 text-xs text-[#8C7667] gap-2">
            <RefreshCw className="h-4 w-4 animate-spin text-[#9E5D2D]" />
            <span>Checking AWS connection state...</span>
          </div>
        ) : awsConnected && !isEditingKeys ? (
          /* Connected State Card */
          <div className="flex flex-col gap-4 p-5 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-2xl bg-[#2E6B4F]/10 text-[#2E6B4F]">
                  <ShieldCheck className="h-6 w-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[#8C7667] font-semibold uppercase tracking-wider">
                      Active AWS Account
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#2E6B4F]/15 text-[#2E6B4F] font-bold">
                      {awsData?.authType === "ACCESS_KEYS" || awsData?.hasAccessKeys
                        ? "AWS Access Keys"
                        : "IAM Role"}
                    </span>
                  </div>
                  <h4 className="text-base font-bold text-[#362217] font-mono">
                    {awsData?.accountId || "Connected account"} ({awsData?.region || "Configured region"})
                  </h4>
                  <p className="text-xs text-[#5E4C3E] font-mono truncate max-w-md mt-0.5">
                    {awsData?.maskedAccessKey
                      ? `Access Key: ${awsData.maskedAccessKey}`
                      : awsData?.roleArn || "IAM Role Active"}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadAwsStatus}
                  icon={RefreshCw}
                  className="text-xs"
                >
                  Verify
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setIsEditingKeys(true);
                    setActiveAwsTab("keys");
                  }}
                  icon={Edit2}
                  className="text-xs"
                >
                  Update Keys
                </Button>
                {awsData?.authType === "ACCESS_KEYS" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setIsEditingKeys(true);
                      setActiveAwsTab("role");
                    }}
                    icon={Cloud}
                    className="text-xs"
                  >
                    Switch to IAM Role
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Unlink}
                  loading={disconnectingAws}
                  onClick={handleDisconnectAws}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 text-xs"
                >
                  Disconnect AWS
                </Button>
              </div>
            </div>

            <div className="pt-3 border-t border-[#EAE1D5] flex flex-col sm:flex-row sm:items-center justify-between text-xs text-[#8C7667] gap-2">
              <span>
                {awsData?.authType === "ACCESS_KEYS" || awsData?.hasAccessKeys ? (
                  <span>
                    Auth Method: <strong className="text-[#362217]">AWS IAM Access Keys</strong>
                  </span>
                ) : (
                  <span>
                    External ID: <code className="font-mono text-[#362217]">{awsData?.externalId}</code>
                  </span>
                )}
              </span>
              <span className="text-[#2E6B4F] font-semibold flex items-center gap-1">
                <Check className="h-3.5 w-3.5" /> Ready for ECS Fargate Deployment
              </span>
            </div>
          </div>
        ) : (
          /* Dual-Mode Setup Wizard: Direct Keys vs IAM Role */
          <div className="flex flex-col gap-5">
            {isEditingKeys && (
              <div className="flex items-center justify-between p-3 rounded-xl bg-[#9E5D2D]/10 border border-[#9E5D2D]/20 text-xs text-[#9E5D2D]">
                <span className="font-semibold">Updating stored AWS credentials:</span>
                <button
                  type="button"
                  onClick={() => setIsEditingKeys(false)}
                  className="font-bold underline hover:text-[#844C22]"
                >
                  Cancel Edit
                </button>
              </div>
            )}

            {/* Mode Tabs */}
            <div className="flex p-1 rounded-xl bg-[#FAF8F5] border border-[#EADFCF] gap-1">
              <button
                type="button"
                onClick={() => setActiveAwsTab("keys")}
                className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                  activeAwsTab === "keys"
                    ? "bg-white text-[#9E5D2D] shadow-xs border border-[#EADFCF]"
                    : "text-[#8C7667] hover:text-[#362217]"
                }`}
              >
                <Key className="h-3.5 w-3.5" />
                AWS Access Keys
              </button>
              <button
                type="button"
                onClick={() => setActiveAwsTab("role")}
                className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                  activeAwsTab === "role"
                    ? "bg-white text-[#9E5D2D] shadow-xs border border-[#EADFCF]"
                    : "text-[#8C7667] hover:text-[#362217]"
                }`}
              >
                <Cloud className="h-3.5 w-3.5" />
                IAM Role (Recommended)
              </button>
            </div>

            {activeAwsTab === "keys" ? (
              /* Tab 1: AWS Access Keys Form */
              <form
                onSubmit={handleSaveAccessKeys}
                className="flex flex-col gap-4 p-5 rounded-2xl border border-[#EADFCF] bg-white shadow-xs"
              >

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-[#5E4C3E] mb-1.5 block">
                      AWS Access Key ID
                    </label>
                    <div className="relative flex items-center">
                      <div className="pointer-events-none absolute left-3.5 text-[#8C7667]">
                        <Key className="h-4 w-4" />
                      </div>
                      <input
                        type="text"
                        placeholder="AKIAIOSFODNN7EXAMPLE"
                        value={accessKeyIdInput}
                        onChange={(e) => setAccessKeyIdInput(e.target.value)}
                        required
                        className="w-full rounded-xl border border-[#DCD0C3] bg-white pl-10 pr-4 py-2.5 text-xs font-mono text-[#362217] placeholder-[#A39284] outline-none transition focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-[#5E4C3E] mb-1.5 block">
                      AWS Secret Access Key
                    </label>
                    <div className="relative flex items-center">
                      <div className="pointer-events-none absolute left-3.5 text-[#8C7667]">
                        <Lock className="h-4 w-4" />
                      </div>
                      <input
                        type={showSecretKey ? "text" : "password"}
                        placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                        value={secretAccessKeyInput}
                        onChange={(e) => setSecretAccessKeyInput(e.target.value)}
                        required
                        className="w-full rounded-xl border border-[#DCD0C3] bg-white pl-10 pr-10 py-2.5 text-xs font-mono text-[#362217] placeholder-[#A39284] outline-none transition focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowSecretKey(!showSecretKey)}
                        className="absolute right-3 text-[#8C7667] hover:text-[#362217]"
                      >
                        {showSecretKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-[#5E4C3E] mb-1.5 block">
                    Session Token (temporary credentials only)
                  </label>
                  <input
                    type={showSecretKey ? "text" : "password"}
                    placeholder="Required when the access key was issued by STS"
                    value={sessionTokenInput}
                    onChange={(event) => setSessionTokenInput(event.target.value)}
                    autoComplete="off"
                    className="w-full rounded-xl border border-[#DCD0C3] bg-white px-4 py-2.5 text-xs font-mono text-[#362217] placeholder-[#A39284] outline-none transition focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-[#5E4C3E] mb-1.5 block">
                      Primary Deployment Region
                    </label>
                    <select
                      value={regionInput}
                      onChange={(e) => setRegionInput(e.target.value)}
                      className="w-full rounded-xl border border-[#DCD0C3] bg-white px-3 py-2.5 text-xs text-[#362217] outline-none focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D] transition shadow-xs"
                    >
                      <option value="ap-south-1">ap-south-1 (Mumbai)</option>
                      <option value="us-east-1">us-east-1 (N. Virginia)</option>
                      <option value="us-west-2">us-west-2 (Oregon)</option>
                      <option value="eu-west-1">eu-west-1 (Ireland)</option>
                      <option value="eu-central-1">eu-central-1 (Frankfurt)</option>
                      <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <p className="text-[11px] text-[#8C7667] pb-2">
                      * ECS clusters, services, and Application Load Balancers will be created in this AWS region.
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-[#EAE1D5]">
                  <span className="text-[11px] text-[#8C7667]">
                    Credentials are verified via AWS STS and stored encrypted. Prefer the IAM role flow for long-term use.
                  </span>
                  <div className="flex items-center gap-2">
                    {isEditingKeys && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setIsEditingKeys(false)}
                        className="text-xs"
                      >
                        Cancel
                      </Button>
                    )}
                    <Button
                      type="submit"
                      size="sm"
                      loading={verifyingAws}
                      className="bg-[#2E6B4F] hover:bg-[#24543D] text-white flex items-center gap-1.5 shadow-sm font-bold"
                    >
                      <ShieldCheck className="h-4 w-4" />
                      Verify & Save AWS Credentials
                    </Button>
                  </div>
                </div>
              </form>
            ) : (
              /* Tab 2: 3-Step Setup Wizard for IAM Role */
              <div className="flex flex-col gap-5">
                {/* Step 1: External ID */}
                <div className="p-4 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div>
                    <span className="text-xs font-bold text-[#9E5D2D] uppercase tracking-wider">
                      Step 1: Your Unique Security External ID
                    </span>
                    <p className="text-xs text-[#5E4C3E] mt-0.5">
                      Recommended for production: SkyForge uses temporary STS credentials and does not store your AWS access keys.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <code className="bg-white px-3 py-1.5 rounded-xl border border-[#EAE1D5] font-mono text-xs font-bold text-[#362217]">
                      {awsData?.externalId || "Generating..."}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCopyExternalId}
                      className="text-xs flex items-center gap-1 bg-white"
                    >
                      {copiedExternalId ? (
                        <Check className="h-3.5 w-3.5 text-[#2E6B4F]" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      {copiedExternalId ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>

                {/* Step 2: CloudFormation Launch */}
                <div className="p-4 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <span className="text-xs font-bold text-[#9E5D2D] uppercase tracking-wider">
                      Step 2: Create IAM Role with CloudFormation
                    </span>
                    <p className="text-xs text-[#5E4C3E] mt-0.5">
                      Download the template JSON, then open CloudFormation and upload it. No manual policy writing is needed.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDownloadCloudFormation}
                      icon={Download}
                      className="text-xs bg-white"
                    >
                      Template JSON
                    </Button>
                    <a
                      href={awsData?.cloudFormationLaunchUrl || undefined}
                      target="_blank"
                      rel="noreferrer"
                      aria-disabled={!awsData?.cloudFormationLaunchUrl}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold shadow-sm transition ${
                        awsData?.cloudFormationLaunchUrl
                          ? "bg-[#9E5D2D] text-white hover:bg-[#844C22]"
                          : "pointer-events-none cursor-not-allowed bg-[#DCD0C3] text-[#8C7667]"
                      }`}
                    >
                      <ExternalLink className="h-4 w-4" />
                      Launch CloudFormation
                    </a>
                  </div>
                </div>

                {/* Step 3: Enter Role ARN & Verify */}
                <form
                  onSubmit={handleConnectAws}
                  className="flex flex-col gap-4 p-4 rounded-2xl border border-[#EADFCF] bg-white"
                >
                  <span className="text-xs font-bold text-[#9E5D2D] uppercase tracking-wider">
                    Step 3: Paste Created Role ARN & Verify
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="md:col-span-2">
                      <Input
                        label="IAM Role ARN"
                        icon={Key}
                        placeholder="arn:aws:iam::123456789012:role/SkyForgeDeploymentRole"
                        value={roleArnInput}
                        onChange={(e) => setRoleArnInput(e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-[#5E4C3E] mb-1.5 block">
                        Deployment Region
                      </label>
                      <select
                        value={regionInput}
                        onChange={(e) => setRegionInput(e.target.value)}
                        className="w-full rounded-xl border border-[#DCD0C3] bg-white px-3 py-2.5 text-xs text-[#362217] outline-none focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D] transition shadow-xs"
                      >
                        <option value="ap-south-1">ap-south-1 (Mumbai)</option>
                        <option value="us-east-1">us-east-1 (N. Virginia)</option>
                        <option value="us-west-2">us-west-2 (Oregon)</option>
                        <option value="eu-west-1">eu-west-1 (Ireland)</option>
                        <option value="eu-central-1">eu-central-1 (Frankfurt)</option>
                        <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <span className="text-[11px] text-[#8C7667]">
                      * Temporary STS credentials will be generated and verified instantly.
                    </span>
                    <Button
                      type="submit"
                      size="sm"
                      loading={verifyingAws}
                      className="bg-[#2E6B4F] hover:bg-[#24543D] text-white flex items-center gap-1.5 shadow-sm"
                    >
                      <ShieldCheck className="h-4 w-4" />
                      Verify & Connect AWS
                    </Button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* GitHub Integration Card */}
      <Card glow={false} className="flex flex-col gap-5 bg-white border border-[#EAE1D5]">
        <div className="flex items-center justify-between border-b border-[#EADFCF] pb-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-[#362217] text-white">
              <GitPullRequest className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-[#362217]">GitHub Integration</h3>
              <p className="text-xs text-[#5E4C3E]">Automated repository scanning and deployment synchronization</p>
            </div>
          </div>

          {isGithubConnected && (
            <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#2E6B4F]/10 text-[#2E6B4F] border border-[#2E6B4F]/30 text-xs font-semibold">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>Connected</span>
            </span>
          )}
        </div>

        {isGithubConnected ? (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5]">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-[#9E5D2D] text-white font-bold flex items-center justify-center text-sm">
                {(githubAccount?.username || user?.github?.username || "G").charAt(0).toUpperCase()}
              </div>
              <div>
                <span className="text-xs text-[#8C7667] font-medium">Connected GitHub Profile</span>
                <h4 className="text-sm font-bold text-[#362217]">
                  @{githubAccount?.username || user?.github?.username || "developer"}
                </h4>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                icon={RefreshCw}
                onClick={handleConnectGitHub}
              >
                Re-authenticate
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={Unlink}
                loading={disconnecting}
                onClick={handleDisconnectGitHub}
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
              >
                Disconnect
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5]">
            <div>
              <h4 className="text-sm font-bold text-[#362217]">No GitHub Account Linked</h4>
              <p className="text-xs text-[#5E4C3E] mt-0.5 max-w-md">
                Connect your GitHub account to enable automatic repository inspection, port detection, and CI/CD pipelines.
              </p>
            </div>
            <Button
              size="sm"
              icon={GitPullRequest}
              onClick={handleConnectGitHub}
            >
              Connect GitHub Account
            </Button>
          </div>
        )}
      </Card>

      {/* User Profile Form */}
      <Card glow={false} className="flex flex-col gap-6 bg-white border border-[#EAE1D5]">
        <h3 className="text-base font-bold text-[#362217] border-b border-[#EADFCF] pb-3">User Profile</h3>
        <form onSubmit={handleProfileSave} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Full Name"
              icon={User}
              placeholder="Your full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              label="Email Address"
              type="email"
              icon={Mail}
              placeholder="your.email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="pt-2 flex justify-end">
            <Button type="submit" icon={Save} size="sm">
              Save Profile
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
