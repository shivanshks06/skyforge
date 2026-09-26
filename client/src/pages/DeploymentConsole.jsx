import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import {
  Rocket,
  Terminal,
  Activity,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  Copy,
  Check,
  Globe,
  Layers,
  ShieldCheck,
  Key,
  RotateCcw,
  Undo2,
  Clock,
  ListOrdered,
  AlertCircle,
  HeartPulse,
  Trash2,
  Flame,
  Lock,
  Eye,
  EyeOff,
  X,
} from "lucide-react";
import Card from "../components/Card";
import Button from "../components/Button";
import {
  getProjectById,
  triggerProjectDeployment,
  retryDeployment,
  rollbackDeployment,
  getDeploymentQueuePosition,
  getDeploymentById,
  getProjectDeployments,
  getAwsStatus,
  saveAwsCredentials,
  destroyDeployment,
  destroyProjectInfrastructure,
  streamDeploymentLogs,
} from "../services/api";

const TERMINAL_STATUSES = new Set([
  "LIVE",
  "FAILED",
  "CANCELLED",
  "ROLLED_BACK",
  "DESTROYED",
  "DESTROY_FAILED",
]);
const ACTIVE_STATUSES = new Set([
  "QUEUED",
  "BUILDING",
  "PUSHING",
  "PROVISIONING",
  "DEPLOYING",
  "HEALTH_CHECK",
  "ROLLING_BACK",
  "DESTROYING",
]);

const STAGE_STATUS = {
  CLONING: "BUILDING",
  BUILDING: "BUILDING",
  PUSHING: "PUSHING",
  PROVISIONING: "PROVISIONING",
  DEPLOYING: "DEPLOYING",
  HEALTH_CHECK: "HEALTH_CHECK",
  LIVE: "LIVE",
  COMPLETE: "LIVE",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  ROLLBACK: "ROLLING_BACK",
  ROLLBACK_COMPLETE: "ROLLED_BACK",
  ROLLBACK_FAILED: "FAILED",
  DESTROY: "DESTROYING",
  DESTROY_COMPLETE: "DESTROYED",
  DESTROY_FAILED: "DESTROY_FAILED",
};

const STAGES = [
  { id: "CLONING", label: "Cloning", desc: "Git repository source" },
  { id: "BUILDING", label: "Building", desc: "Multi-stage Docker build" },
  { id: "PUSHING", label: "Pushing", desc: "Push container to AWS ECR" },
  { id: "PROVISIONING", label: "Provisioning", desc: "Terraform VPC & ECS" },
  { id: "DEPLOYING", label: "Deploying", desc: "ECS Service / S3 Sync" },
  { id: "HEALTH_CHECK", label: "Health Check", desc: "HTTP 200 Probe & Latency" },
  { id: "COMPLETE", label: "Live", desc: "Production traffic active" },
];

export default function DeploymentConsole() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [project, setProject] = useState(null);
  const [awsConnected, setAwsConnected] = useState(false);
  const [awsData, setAwsData] = useState(null);
  const [activeDeployment, setActiveDeployment] = useState(null);
  const [logs, setLogs] = useState([]);
  const [deploying, setDeploying] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [showRollbackModal, setShowRollbackModal] = useState(false);
  const [showDestroyModal, setShowDestroyModal] = useState(false);
  const [showAwsModal, setShowAwsModal] = useState(false);
  const [awsAccessKeyInput, setAwsAccessKeyInput] = useState("");
  const [awsSecretKeyInput, setAwsSecretKeyInput] = useState("");
  const [awsSessionTokenInput, setAwsSessionTokenInput] = useState("");
  const [awsRegionInput, setAwsRegionInput] = useState("ap-south-1");
  const [showAwsSecret, setShowAwsSecret] = useState(false);
  const [savingAwsKeys, setSavingAwsKeys] = useState(false);
  const [awsModalNotice, setAwsModalNotice] = useState(null);
  const [rollbackReason, setRollbackReason] = useState("Reverting to previous stable revision");
  const [queueInfo, setQueueInfo] = useState({ position: 1, totalWaiting: 1 });
  const [loading, setLoading] = useState(true);
  const [deployError, setDeployError] = useState(null);
  const [deployBlockers, setDeployBlockers] = useState([]);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedLogs, setCopiedLogs] = useState(false);

  const logsEndRef = useRef(null);
  const eventSourceRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const pollInFlightRef = useRef(false);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const stopPolling = () => {
    if (pollIntervalRef.current) window.clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = null;
    pollInFlightRef.current = false;
  };

  const settleTerminalState = (status) => {
    if (!TERMINAL_STATUSES.has(status)) return false;
    stopPolling();
    setDeploying(false);
    setRetrying(false);
    setRollingBack(false);
    setDestroying(false);
    return true;
  };

  const startStatusPolling = (deploymentId, interval = 3000) => {
    stopPolling();
    if (!deploymentId) return;
    pollIntervalRef.current = window.setInterval(async () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        await pollDeploymentStatus(deploymentId);
      } finally {
        pollInFlightRef.current = false;
      }
    }, interval);
  };

  const loadInitialData = async () => {
    try {
      setLoading(true);
      const [projData, awsStatus, deployments] = await Promise.all([
        getProjectById(id),
        getAwsStatus().catch(() => ({ connected: false })),
        getProjectDeployments(id).catch(() => []),
      ]);

      setProject(projData);
      setAwsConnected(awsStatus.connected);
      setAwsData(awsStatus);

      if (deployments && deployments.length > 0) {
        const requestedDeploymentId = searchParams.get("deploymentId");
        const latest = deployments.find((entry) => entry.id === requestedDeploymentId) || deployments[0];
        setActiveDeployment(latest);

        if (latest.status === "QUEUED") {
          fetchQueuePos(latest.id);
        }

        if (TERMINAL_STATUSES.has(latest.status)) {
          const depData = await getDeploymentById(latest.id);
          if (depData?.logs) setLogs(depData.logs);
          if (depData?.deployment) setActiveDeployment(depData.deployment);
          if (["LIVE", "ROLLED_BACK"].includes(latest.status)) startStatusPolling(latest.id, 30_000);
        } else {
          subscribeToLogs(latest.id);
          startStatusPolling(latest.id);
        }
      }
    } catch (err) {
      console.error("Failed to load deployment data:", err);
      setDeployError(err.response?.data?.message || "Unable to load deployment data.");
    } finally {
      setLoading(false);
    }
  };

  const fetchQueuePos = async (deploymentId) => {
    try {
      const res = await getDeploymentQueuePosition(deploymentId);
      setQueueInfo({
        position: Number.isInteger(res?.position) ? res.position : null,
        totalWaiting: Number.isInteger(res?.totalWaiting) ? res.totalWaiting : null,
        status: res?.status || "UNKNOWN",
      });
    } catch {
      // fallback
    }
  };

  const subscribeToLogs = (deploymentId) => {
    eventSourceRef.current?.abort();
    const controller = new AbortController();
    eventSourceRef.current = controller;

    void streamDeploymentLogs(deploymentId, {
      signal: controller.signal,
      onMessage: (data) => {
        setLogs((prev) => prev.some((entry) => entry.id === data.id) ? prev : [...prev, data]);
        const mappedStatus = STAGE_STATUS[data.stage];
        if (mappedStatus) {
          const mappedStage = data.stage === "LIVE" ? "COMPLETE" : data.stage;
          setActiveDeployment((previous) => ({
            ...previous,
            stage: mappedStage,
            currentStep: data.stage,
            status: mappedStatus,
          }));
          if (TERMINAL_STATUSES.has(mappedStatus)) {
            controller.abort();
            window.setTimeout(() => void pollDeploymentStatus(deploymentId), 300);
          }
        }
      },
      onError: (streamError) => {
        if (streamError.name !== "AbortError") {
          console.warn("Deployment log stream ended:", streamError);
          startStatusPolling(deploymentId);
        }
      },
    }).catch((streamError) => {
      if (streamError.name !== "AbortError") {
        console.warn("Deployment log stream ended:", streamError);
        startStatusPolling(deploymentId);
      }
    });
  };

  const pollDeploymentStatus = async (deploymentId) => {
    try {
      const data = await getDeploymentById(deploymentId);
      if (data?.logs?.length) {
        setLogs((previous) => {
          const merged = new Map(previous.map((entry) => [entry.id, entry]));
          for (const entry of data.logs) merged.set(entry.id, entry);
          return [...merged.values()].slice(-1000);
        });
      }
      if (data?.deployment) {
        setActiveDeployment(data.deployment);
        if (data.deployment.error && ["LIVE", "ROLLED_BACK"].includes(data.deployment.status)) {
          setDeployError(data.deployment.error);
        }
        settleTerminalState(data.deployment.status);
        if (data.deployment.status === "QUEUED") await fetchQueuePos(deploymentId);
      }
      const updatedProj = await getProjectById(id);
      setProject(updatedProj);
    } catch (err) {
      console.error("Poll error:", err);
    }
  };

  useEffect(() => {
    const task = window.setTimeout(() => {
      void loadInitialData();
    }, 0);
    return () => {
      window.clearTimeout(task);
      eventSourceRef.current?.abort();
      stopPolling();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleTriggerDeploy = async () => {
    try {
      setDeploying(true);
      setDeployError(null);
      setDeployBlockers([]);
      setLogs([]);
      const res = await triggerProjectDeployment(id);
      const newDeployment = res.deployment;
      setActiveDeployment(newDeployment);
      subscribeToLogs(newDeployment.id);
      startStatusPolling(newDeployment.id);
      fetchQueuePos(newDeployment.id);
    } catch (err) {
      console.error("Deploy trigger error:", err);
      const blockers = err.response?.data?.blockers || [];
      const msg = err.response?.data?.message || err.message || "Failed to trigger deployment.";
      setDeployError(msg);
      setDeployBlockers(blockers);
      if (blockers.some((b) => /aws|credentials|account/i.test(b))) {
        setShowAwsModal(true);
      }
      setDeploying(false);
    }
  };

  const handleRetryDeploy = async () => {
    if (!activeDeployment) return;
    try {
      setRetrying(true);
      setDeploying(true);
      const res = await retryDeployment(activeDeployment.id);
      const updated = res.deployment || activeDeployment;
      const nextDeploymentId = updated.id;
      setActiveDeployment({
        ...updated,
        status: "QUEUED",
        stage: "CLONING",
      });
      subscribeToLogs(nextDeploymentId);
      startStatusPolling(nextDeploymentId);
      fetchQueuePos(nextDeploymentId);
    } catch (err) {
      console.error("Retry error:", err);
      setDeployError(err.response?.data?.message || "Retry could not be queued.");
      setRetrying(false);
      setDeploying(false);
    }
  };

  const handleRollback = async () => {
    if (!activeDeployment) return;
    try {
      setRollingBack(true);
      setShowRollbackModal(false);
      await rollbackDeployment(activeDeployment.id, rollbackReason);
      setActiveDeployment((prev) => ({
        ...prev,
        status: "ROLLING_BACK",
        stage: "ROLLBACK",
      }));
      subscribeToLogs(activeDeployment.id);
      startStatusPolling(activeDeployment.id);
    } catch (err) {
      console.error("Rollback error:", err);
      setDeployError(err.response?.data?.message || "Rollback could not be queued.");
      setRollingBack(false);
    }
  };

  const handleDestroy = async () => {
    setDestroying(true);
    setDeployError(null);
    setDeployBlockers([]);
    setShowDestroyModal(false);
    try {
      const deploymentId = activeDeployment?.id;
      let targetDepId = deploymentId;

      if (deploymentId && activeDeployment?.status !== "DESTROYED") {
        subscribeToLogs(deploymentId);
        const res = await destroyDeployment(deploymentId);
        if (res?.deploymentId) targetDepId = res.deploymentId;
      } else {
        const res = await destroyProjectInfrastructure(id);
        if (res?.deploymentId) {
          targetDepId = res.deploymentId;
          subscribeToLogs(targetDepId);
        }
      }

      // Optimistically update active deployment to DESTROYING
      setActiveDeployment((prev) => ({
        ...(prev || {}),
        id: targetDepId || prev?.id,
        status: "DESTROYING",
        stage: "DESTROY",
        currentStep: "DESTROY",
      }));

      if (targetDepId) startStatusPolling(targetDepId);
    } catch (err) {
      console.error("Destroy error:", err);
      setDeployError(err.response?.data?.message || "Infrastructure teardown could not be started.");
      setDestroying(false);
    } finally {
      // Safety unlock so button never remains indefinitely stuck in loading state
      window.setTimeout(() => setDestroying(false), 8000);
    }
  };

  const handleSaveAwsModalCredentials = async (e) => {
    e.preventDefault();
    if (!awsAccessKeyInput.trim() || !awsSecretKeyInput.trim()) {
      setAwsModalNotice({
        type: "error",
        message: "Please enter both your AWS Access Key ID and Secret Access Key.",
      });
      return;
    }

    setSavingAwsKeys(true);
    setAwsModalNotice(null);
    try {
      const res = await saveAwsCredentials({
        accessKeyId: awsAccessKeyInput.trim(),
        secretAccessKey: awsSecretKeyInput.trim(),
        sessionToken: awsSessionTokenInput.trim() || undefined,
        region: awsRegionInput,
      });
      setAwsConnected(true);
      setAwsData(res);
      setAwsModalNotice({
        type: "success",
        message: `AWS Connected! Account: ${res.accountId || "Active"} (${res.region || awsRegionInput})`,
      });
      setTimeout(() => {
        setShowAwsModal(false);
        setAwsAccessKeyInput("");
        setAwsSecretKeyInput("");
        setAwsSessionTokenInput("");
        setAwsModalNotice(null);
      }, 1000);
    } catch (err) {
      setAwsModalNotice({
        type: "error",
        message: err.response?.data?.message || err.message || "Failed to verify AWS credentials.",
      });
    } finally {
      setSavingAwsKeys(false);
    }
  };

  const handleCopyUrl = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      setDeployError("Clipboard access was denied.");
    }
  };

  const handleCopyAllLogs = async () => {
    const text = logs.map((entry) => `[${entry.timestamp}] [${entry.stage}] ${entry.message}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLogs(true);
      window.setTimeout(() => setCopiedLogs(false), 2000);
    } catch {
      setDeployError("Clipboard access was denied.");
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <RefreshCw className="h-8 w-8 text-[#9E5D2D] animate-spin" />
        <p className="text-sm font-semibold text-[#8C7667]">
          Connecting to BullMQ worker & deployment telemetry...
        </p>
      </div>
    );
  }

  const currentStage = activeDeployment?.stage || (activeDeployment?.status === "LIVE" ? "COMPLETE" : "CLONING");
  const isQueued = activeDeployment?.status === "QUEUED";
  const isActiveOperation = ACTIVE_STATUSES.has(activeDeployment?.status);
  const isDestroyFailed = activeDeployment?.status === "DESTROY_FAILED";
  const isFailed = ["FAILED", "DESTROY_FAILED", "CANCELLED"].includes(activeDeployment?.status);
  const canRetryDeployment = ["FAILED", "CANCELLED"].includes(activeDeployment?.status);
  const isRollingBack = activeDeployment?.status === "ROLLING_BACK";
  const isRolledBack = activeDeployment?.status === "ROLLED_BACK";
  const isDestroying = activeDeployment?.status === "DESTROYING" || destroying;
  const isDestroyed = !isDestroying && activeDeployment?.status === "DESTROYED";
  const isLive = !isDestroyed && !isDestroying && activeDeployment?.status === "LIVE";
  const isBuilding = Boolean(deploying || (!isDestroyed && !isDestroying && ["CLONING", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK"].includes(activeDeployment?.status || activeDeployment?.stage)));
  const hasLiveEndpoint = isLive || isRolledBack;
  const liveUrl = activeDeployment?.liveUrl || null;
  const healthStatus = activeDeployment?.healthStatus || "UNKNOWN";
  const latency = Number.isInteger(activeDeployment?.latencyMs) ? `${activeDeployment.latencyMs}ms` : "Not measured";

  // Calculate current stage index
  const stageIndex = STAGES.findIndex((s) => s.id === currentStage);
  const activeIdx = stageIndex >= 0
    ? stageIndex
    : (isLive || isRolledBack)
      ? STAGES.length - 1
      : (isRollingBack || isDestroying)
        ? STAGES.findIndex((stage) => stage.id === "DEPLOYING")
        : 0;
  const queuePositionLabel = Number.isInteger(queueInfo.position) ? `#${queueInfo.position}` : "starting";

  return (
    <div className="flex flex-col gap-8 max-w-6xl mx-auto pb-16">
      {/* Header & Breadcrumb */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#EADFCF] pb-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-[#8C7667]">
            <Link to="/dashboard/projects" className="hover:text-[#362217] transition-colors">
              Projects
            </Link>
            <span>/</span>
            <span className="text-[#362217]">{project?.name || "Project"}</span>
            <span>/</span>
            <span className="text-[#9E5D2D] font-bold">Deployment Pipeline</span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl md:text-3xl font-bold text-[#362217] flex items-center gap-2.5">
              <Rocket className="h-7 w-7 text-[#9E5D2D]" />
              Deployment Console
            </h1>
            <span className="text-xs px-2.5 py-1 rounded-full bg-[#9E5D2D]/10 text-[#9E5D2D] font-bold border border-[#9E5D2D]/20">
              {project?.framework || "React"}
            </span>

            {/* Status Pill */}
            <span
              className={`text-xs px-2.5 py-1 rounded-full font-bold border flex items-center gap-1.5 ${
                isDestroyed
                  ? "bg-[#362217]/10 text-[#362217] border-[#362217]/25"
                  : isDestroying
                  ? "bg-[#9E2A2B]/15 text-[#9E2A2B] border-[#9E2A2B]/40 animate-pulse"
                  : isLive
                  ? "bg-[#2E6B4F]/10 text-[#2E6B4F] border-[#2E6B4F]/20"
                  : isFailed
                  ? "bg-[#9E2A2B]/10 text-[#9E2A2B] border-[#9E2A2B]/20"
                  : isQueued
                  ? "bg-[#D97706]/10 text-[#D97706] border-[#D97706]/20"
                  : isRollingBack
                  ? "bg-[#6D28D9]/10 text-[#6D28D9] border-[#6D28D9]/20"
                  : isRolledBack
                  ? "bg-[#2563EB]/10 text-[#2563EB] border-[#2563EB]/20"
                  : deploying
                  ? "bg-[#B45309]/10 text-[#B45309] border-[#B45309]/20"
                  : "bg-[#F5EFE6] text-[#5E4C3E] border-[#EADFCF]"
              }`}
            >
              {isDestroyed ? (
                <Trash2 className="h-3.5 w-3.5" />
              ) : isDestroying ? (
                <Flame className="h-3.5 w-3.5 text-[#9E2A2B] animate-bounce" />
              ) : isLive ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : isFailed ? (
                <AlertCircle className="h-3.5 w-3.5" />
              ) : isQueued ? (
                <ListOrdered className="h-3.5 w-3.5 animate-pulse" />
              ) : (
                <Activity className="h-3.5 w-3.5 animate-pulse" />
              )}
              {isDestroyed
                ? "All AWS Resources Destroyed"
                : isDestroying
                ? "Tearing Down AWS..."
                : isLive
                ? "Live in Production"
                : isFailed
                ? "Execution Paused"
                : isQueued
                ? `Queued (Pos ${queuePositionLabel})`
                : isRollingBack
                ? "Rolling Back..."
                : isRolledBack
                ? "Restored (Rolled Back)"
                : deploying
                ? "Worker Executing"
                : "Ready to Deploy"}
            </span>

            <span className="text-xs px-2.5 py-1 rounded-full bg-[#362217] text-[#FAF6F0] font-semibold">
              Target: {project?.deploymentTarget || "AWS ECS Fargate"}
            </span>
          </div>

          <p className="text-sm text-[#5E4C3E]">
            Production-grade asynchronous deployment queue powered by BullMQ & Redis, dedicated workers, and real-time SSE telemetry.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0 flex-wrap">
          <Button
            variant="outline"
            onClick={() => navigate(`/project/${id}/infrastructure`)}
            className="border-[#EADFCF] bg-white text-[#5E4C3E]"
          >
            Terraform IaC
          </Button>

          {hasLiveEndpoint && (
            <Button
              variant="outline"
              onClick={() => setShowRollbackModal(true)}
              loading={rollingBack}
              disabled={rollingBack || destroying}
              className="border-[#6D28D9]/30 text-[#6D28D9] hover:bg-[#6D28D9]/10 font-semibold flex items-center gap-1.5"
            >
              <Undo2 className="h-4 w-4" />
              Rollback
            </Button>
          )}

          <Button
            variant="outline"
            onClick={() => setShowDestroyModal(true)}
            loading={destroying}
            disabled={destroying || isBuilding || isRollingBack}
            className="border-[#9E2A2B]/40 text-[#9E2A2B] hover:bg-[#9E2A2B]/10 hover:border-[#9E2A2B] font-semibold flex items-center gap-1.5 shadow-xs transition-colors"
          >
            <Trash2 className="h-4 w-4 text-[#9E2A2B]" />
            One-Click Destroy
          </Button>

          {isDestroyFailed ? (
            <Button
              onClick={handleDestroy}
              loading={destroying}
              disabled={destroying}
              className="bg-[#9E2A2B] hover:bg-[#7E2223] text-white flex items-center gap-2 shadow-sm font-bold"
            >
              <RefreshCw className="h-4 w-4" />
              Retry Teardown
            </Button>
          ) : canRetryDeployment ? (
            <Button
              onClick={handleRetryDeploy}
              loading={retrying}
              disabled={retrying || destroying}
              className="bg-[#D97706] hover:bg-[#B45309] text-white flex items-center gap-2 shadow-sm font-bold"
            >
              <RotateCcw className="h-4 w-4" />
              Retry Deployment
            </Button>
          ) : (
            <Button
              onClick={handleTriggerDeploy}
              loading={deploying || isQueued || destroying}
              disabled={deploying || isQueued || destroying || isActiveOperation}
              className="bg-[#9E5D2D] hover:bg-[#844C22] text-white flex items-center gap-2 shadow-sm font-bold"
            >
              <Rocket className="h-4 w-4" />
              {hasLiveEndpoint ? "Redeploy Pipeline" : isDestroyed ? "Deploy Clean Architecture" : "Deploy to AWS Now"}
            </Button>
          )}
        </div>
      </div>

      {/* Preflight Blockers Alert */}
      {(deployError || deployBlockers.length > 0) && (
        <div className="p-5 rounded-2xl bg-[#9E2A2B]/10 border border-[#9E2A2B]/30 flex flex-col gap-3 text-xs text-[#7E2223] animate-in fade-in">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-[#9E2A2B]/20 text-[#9E2A2B] shrink-0 mt-0.5">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <span className="font-bold text-[#7E2223] text-sm">
                  {deployError || "Deployment Preflight Blocked"}
                </span>
                {deployBlockers.length > 0 ? (
                  <>
                    <p className="text-xs text-[#9E2A2B] mt-0.5">
                      The following requirements must be resolved before deploying:
                    </p>
                    <ul className="list-disc list-inside mt-2 space-y-1 font-medium text-[#7E2223]">
                      {deployBlockers.map((blocker, idx) => (
                        <li key={idx}>{blocker}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="text-xs text-[#9E2A2B] mt-0.5">
                    Please review your project configuration or AWS connection settings.
                  </p>
                )}
              </div>
            </div>
            <button
              aria-label="Dismiss deployment notice"
              onClick={() => { setDeployError(null); setDeployBlockers([]); }}
              className="p-1 rounded-lg text-[#9E2A2B] hover:bg-[#9E2A2B]/20 transition"
              title="Dismiss notice"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center gap-3 pt-2 border-t border-[#9E2A2B]/20">
            {deployBlockers.some((b) => /aws|credentials|account/i.test(b)) && (
              <Button
                size="sm"
                className="bg-[#2E6B4F] hover:bg-[#24543D] text-white font-bold flex items-center gap-1.5"
                onClick={() => setShowAwsModal(true)}
              >
                <ShieldCheck className="h-4 w-4" />
                Connect AWS Credentials
              </Button>
            )}
            {deployBlockers.some((b) => /environment variable/i.test(b)) && (
              <Button
                size="sm"
                variant="outline"
                className="border-[#9E2A2B]/40 text-[#9E2A2B] hover:bg-[#9E2A2B]/10 font-bold"
                onClick={() => navigate(`/project/${id}/plan`)}
              >
                Configure Environment Variables
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Queue Position Alert (When Queued) */}
      {isQueued && (
        <div className="p-4 rounded-2xl bg-[#D97706]/10 border border-[#D97706]/30 flex items-center justify-between text-xs text-[#92400E]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-[#D97706]/20 text-[#D97706]">
              <ListOrdered className="h-5 w-5 animate-bounce" />
            </div>
            <div>
              <span className="font-bold text-[#78350F] text-sm">
                Asynchronous Job Enqueued in BullMQ (Position {queuePositionLabel})
              </span>
              <p className="text-xs text-[#92400E] mt-0.5">
                The Express API created your deployment job and returned immediately. A dedicated background worker is allocating container resources...
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 font-mono font-bold">
            <Clock className="h-4 w-4" />
            <span>Waiting in queue...</span>
          </div>
        </div>
      )}

      {/* Step-Level Retry Banner (When Failed) */}
      {isFailed && (
        <div className="p-5 rounded-2xl bg-[#9E2A2B]/10 border border-[#9E2A2B]/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs text-[#7E2223]">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-xl bg-[#9E2A2B]/20 text-[#9E2A2B] shrink-0 mt-0.5">
              <AlertCircle className="h-5 w-5" />
            </div>
            <div>
              <span className="font-bold text-[#7E2223] text-sm">
                {isDestroyFailed
                  ? "Infrastructure teardown did not complete"
                  : `Deployment Paused at Step: ${activeDeployment?.currentStep || "BUILDING"}`}
              </span>
              <p className="text-xs text-[#9E2A2B] mt-1 font-mono">
                Reason: {activeDeployment?.error || (isDestroyFailed ? "Cloud resources may still exist." : "Pipeline interrupted during execution.")}
              </p>
              <p className="text-[11px] text-[#5E4C3E] mt-1">
                {isDestroyFailed
                  ? "Retry the idempotent teardown worker. SkyForge will verify each recorded AWS resource is gone before marking the project destroyed."
                  : "SkyForge reruns the verified clone, build, push, provisioning, deployment, and health-check pipeline so every artifact is reproducible."}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={isDestroyFailed ? handleDestroy : handleRetryDeploy}
            loading={isDestroyFailed ? destroying : retrying}
            disabled={isDestroyFailed ? destroying : retrying || destroying}
            className="bg-[#9E2A2B] hover:bg-[#7E2223] text-white shrink-0 font-bold flex items-center gap-2"
          >
            {isDestroyFailed ? <RefreshCw className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
            {isDestroyFailed ? "Retry Teardown" : "Retry Full Pipeline"}
          </Button>
        </div>
      )}

      {/* AWS Connection Status Pill */}
      <div className="p-4 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-[#2E6B4F]/10 text-[#2E6B4F]">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-[#362217]">AWS Cloud Account: </span>
              {awsConnected && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#2E6B4F]/15 text-[#2E6B4F] font-bold">
                  {awsData?.authType === "ACCESS_KEYS" || awsData?.hasAccessKeys
                    ? "Direct IAM Keys"
                    : "IAM Role"}
                </span>
              )}
            </div>
            <span className="font-mono text-[#5E4C3E]">
              {awsConnected
                ? `Account: ${awsData?.accountId || "connected account"} (${awsData?.region || "configured region"})${
                    awsData?.maskedAccessKey ? ` • Key: ${awsData.maskedAccessKey}` : ""
                  }`
                : "No AWS account connected — connect credentials to deploy"}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => {
              setAwsRegionInput(awsData?.region || "ap-south-1");
              setShowAwsModal(true);
            }}
            className="text-xs font-bold px-3 py-1.5 rounded-lg bg-[#9E5D2D] text-white hover:bg-[#844C22] transition flex items-center gap-1.5 shadow-xs cursor-pointer"
          >
            <Key className="h-3.5 w-3.5" />
            {awsConnected ? "Update AWS Keys" : "Connect AWS Keys"}
          </button>
          <Link
            to="/dashboard/settings"
            className="text-xs font-semibold text-[#8C7667] hover:text-[#362217] hover:underline"
          >
            Full Settings →
          </Link>
        </div>
      </div>

      {/* Stage Stepper Pipeline */}
      <Card glow={false} className="bg-white border border-[#EAE1D5] flex flex-col gap-4">
        <div className="flex items-center justify-between border-b border-[#EADFCF] pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-[#9E5D2D]/10 text-[#9E5D2D]">
              <Layers className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-[#362217]">Deployment Pipeline Stages</h3>
              <p className="text-xs text-[#5E4C3E]">
                Autonomous execution of containerization, registry distribution, and infrastructure synthesis.
              </p>
            </div>
          </div>
          <span className="text-xs font-mono font-bold text-[#9E5D2D]">
            {deploying ? "Status: Worker Active" : isQueued ? "Status: Queued" : hasLiveEndpoint ? "Status: Deployed" : isFailed ? "Status: Paused" : "Status: Idle"}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {STAGES.map((s, idx) => {
            const isPassed = hasLiveEndpoint || (!isFailed && idx < activeIdx);
            const isCurrent = (deploying || isQueued) && idx === activeIdx;
            const isStepFailed = isFailed && idx === activeIdx;

            return (
              <div
                key={s.id}
                className={`p-3 rounded-2xl border transition-all flex flex-col gap-1.5 ${
                  isPassed
                    ? "bg-[#2E6B4F]/5 border-[#2E6B4F]/30 text-[#2E6B4F]"
                    : isStepFailed
                    ? "bg-[#9E2A2B]/10 border-[#9E2A2B] text-[#9E2A2B] ring-2 ring-[#9E2A2B]/20"
                    : isCurrent
                    ? "bg-[#9E5D2D]/10 border-[#9E5D2D] text-[#9E5D2D] ring-2 ring-[#9E5D2D]/20 animate-pulse"
                    : "bg-[#FAF8F5] border-[#EADFCF] text-[#8C7667]"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider font-mono">
                    0{idx + 1}
                  </span>
                  {isPassed ? (
                    <CheckCircle2 className="h-4 w-4 text-[#2E6B4F]" />
                  ) : isStepFailed ? (
                    <AlertCircle className="h-4 w-4 text-[#9E2A2B]" />
                  ) : isCurrent ? (
                    <Activity className="h-4 w-4 text-[#9E5D2D]" />
                  ) : (
                    <div className="h-2 w-2 rounded-full bg-[#DCD0C3]" />
                  )}
                </div>
                <span className="text-xs font-bold text-[#362217]">{s.label}</span>
                <span className="text-[10px] text-[#8C7667] leading-tight">{s.desc}</span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Live Application Card (When Live) */}
      {hasLiveEndpoint && (
        <div className="p-6 rounded-3xl bg-gradient-to-r from-[#2E6B4F]/10 via-white to-[#2E6B4F]/10 border-2 border-[#2E6B4F]/40 shadow-sm flex flex-col md:flex-row items-center justify-between gap-5">
          <div className="flex items-start gap-4">
            <div className="p-3.5 rounded-2xl bg-[#2E6B4F] text-white shadow-sm shrink-0">
              <Globe className="h-7 w-7" />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[#2E6B4F] uppercase tracking-wider">
                  Live Application Endpoint
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded-md font-bold ${healthStatus === "HEALTHY" ? "bg-[#2E6B4F] text-white" : "bg-[#D97706] text-white"}`}>
                  {healthStatus === "HEALTHY" ? "Verified healthy" : `Health: ${healthStatus}`}
                </span>
              </div>
              <h3 className="text-lg font-bold text-[#362217] font-mono">{liveUrl || "Endpoint unavailable"}</h3>
              <div className="flex flex-wrap items-center gap-4 text-xs text-[#5E4C3E] mt-1 font-mono">
                <span>Latency: <strong>{latency}</strong></span>
                <span>•</span>
                <span>Target: <strong>{activeDeployment?.target || project?.deploymentTarget || "AWS"}</strong></span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {liveUrl && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleCopyUrl(liveUrl)}
                  className="text-xs flex items-center gap-1.5 bg-white border-[#EADFCF]"
                >
                  {copiedUrl ? <Check className="h-3.5 w-3.5 text-[#2E6B4F]" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedUrl ? "Copied" : "Copy URL"}
                </Button>
                <a
                  href={liveUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-[#24543D] bg-[#2E6B4F] px-3.5 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-[#24543D]"
                >
                  Open App <ExternalLink className="h-4 w-4" />
                </a>
              </>
            )}
          </div>
        </div>
      )}

      {/* Clean-Slate Post-Destroy Card (When Destroyed) */}
      {isDestroyed && (
        <div className="p-6 rounded-3xl bg-gradient-to-r from-[#FAF8F5] via-white to-[#FAF8F5] border-2 border-[#DCD0C3] shadow-sm flex flex-col md:flex-row items-center justify-between gap-5">
          <div className="flex items-start gap-4">
            <div className="p-3.5 rounded-2xl bg-[#362217] text-white shadow-sm shrink-0">
              <Trash2 className="h-7 w-7 text-[#D97706]" />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[#362217] uppercase tracking-wider">
                  Cloud Infrastructure Status
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-md font-bold bg-[#362217] text-[#FAF8F5]">
                  0 Active AWS Resources
                </span>
              </div>
              <h3 className="text-lg font-bold text-[#362217]">
                All AWS Cloud Infrastructure Destroyed
              </h3>
              <p className="text-xs text-[#5E4C3E] max-w-xl">
                Recorded ECS, ECR, S3, CloudFront, IAM, load-balancer, security-group, secret, and log resources were verified absent. Unrelated resources in the connected account are left untouched.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <Button
              onClick={handleTriggerDeploy}
              loading={deploying}
              className="bg-[#9E5D2D] hover:bg-[#844C22] text-white flex items-center gap-2 shadow-sm font-bold"
            >
              <Rocket className="h-4 w-4" />
              <span>Deploy Clean Architecture</span>
            </Button>
          </div>
        </div>
      )}

      {/* Continuous Health & Monitoring Card */}
      {hasLiveEndpoint && (
        <Card glow={false} className="bg-white border border-[#EAE1D5] flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-[#EADFCF] pb-3">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-[#2E6B4F]/10 text-[#2E6B4F]">
                <HeartPulse className="h-5 w-5 animate-pulse" />
              </div>
              <div>
                <h3 className="text-base font-bold text-[#362217]">Automated Monitoring Worker</h3>
                <p className="text-xs text-[#5E4C3E]">
                  Periodic edge probes verify ALB target health, container uptime, and round-trip response metrics.
                </p>
              </div>
            </div>
            <span className={`text-xs font-mono font-bold flex items-center gap-1.5 ${healthStatus === "HEALTHY" ? "text-[#2E6B4F]" : "text-[#D97706]"}`}>
              <span className={`h-2 w-2 rounded-full ${healthStatus === "HEALTHY" ? "bg-[#2E6B4F] animate-ping" : "bg-[#D97706]"}`} />
              {healthStatus === "HEALTHY" ? "Health probe verified" : "Health probe pending"}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="p-3 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-1">
              <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">Health Status</span>
              <span className={`text-sm font-bold flex items-center gap-1 ${healthStatus === "HEALTHY" ? "text-[#2E6B4F]" : "text-[#D97706]"}`}>
                {healthStatus === "HEALTHY" ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />} {healthStatus}
              </span>
            </div>
            <div className="p-3 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-1">
              <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">Round-Trip Latency</span>
              <span className="text-sm font-bold text-[#362217] font-mono">{latency}</span>
            </div>
            <div className="p-3 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-1">
              <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">Compute State</span>
              <span className="text-sm font-bold text-[#362217]">{activeDeployment?.target || project?.deploymentTarget || "AWS"}</span>
            </div>
            <div className="p-3 rounded-2xl bg-[#FAF8F5] border border-[#EAE1D5] flex flex-col gap-1">
              <span className="text-[10px] font-bold text-[#8C7667] uppercase tracking-wider">Uptime Rate</span>
              <span className="text-sm font-bold text-[#5E4C3E]">Not measured</span>
            </div>
          </div>
        </Card>
      )}

      {/* Live Terminal Console */}
      <Card glow={false} className="flex flex-col gap-0 p-0 overflow-hidden bg-[#1E1E1E] border border-[#362217] shadow-lg">
        {/* Terminal Header */}
        <div className="flex items-center justify-between bg-[#2A2A2A] border-b border-[#3D3D3D] px-4 py-2.5">
          <div className="flex items-center gap-3">
            {/* macOS Window Controls */}
            <div className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded-full bg-[#FF5F56]" />
              <div className="h-3 w-3 rounded-full bg-[#FFBD2E]" />
              <div className="h-3 w-3 rounded-full bg-[#27C93F]" />
            </div>
            <div className="flex items-center gap-2 text-xs font-mono text-[#D4D4D4]">
              <Terminal className="h-3.5 w-3.5 text-[#9E5D2D]" />
              <span>SkyForge Real-Time Deployment Pipeline</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono text-[#8C7667] uppercase">
              {deploying ? "STREAMING TELEMETRY" : "TERMINAL IDLE"}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyAllLogs}
              className="text-xs bg-transparent border-[#4D4D4D] text-[#D4D4D4] hover:bg-[#3D3D3D] py-1 px-2.5 h-auto"
            >
              {copiedLogs ? <Check className="h-3 w-3 text-[#2E6B4F]" /> : <Copy className="h-3 w-3" />}
              <span>{copiedLogs ? "Copied" : "Copy"}</span>
            </Button>
          </div>
        </div>

        {/* Terminal Body */}
        <div className="p-5 font-mono text-xs overflow-y-auto max-h-[500px] flex flex-col gap-1.5 leading-relaxed text-[#D4D4D4]">
          {logs.length === 0 ? (
            <div className="text-[#8C7667] italic py-8 text-center">
              Awaiting deployment trigger. Click 'Deploy to AWS Now' above to initialize worker and stream logs...
            </div>
          ) : (
            logs.map((log) => {
              const isError = log.level === "error" || log.stage === "FAILED";
              const isSuccess = log.level === "success" || log.stage === "LIVE";
              const isWarn = log.level === "warn" || log.stage === "ROLLBACK";
              const isDestroy = log.stage === "DESTROY";

              return (
                <div key={log.id} className="flex items-start gap-2 hover:bg-white/5 py-0.5 px-1 rounded transition-colors">
                  <span className="text-[#8C7667] shrink-0 select-none">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span
                    className={`font-bold shrink-0 uppercase text-[10px] px-1.5 py-0.2 rounded font-mono ${
                      isDestroy
                        ? "bg-[#9E2A2B]/40 text-[#FFA8A8] border border-[#9E2A2B]/60"
                        : isError
                        ? "bg-[#9E2A2B]/30 text-[#FF6B6B]"
                        : isSuccess
                        ? "bg-[#2E6B4F]/30 text-[#4EBA87]"
                        : isWarn
                        ? "bg-[#D97706]/30 text-[#F59E0B]"
                        : "bg-white/10 text-[#E8C39E]"
                    }`}
                  >
                    [{log.stage}]
                  </span>
                  <span
                    className={`whitespace-pre-wrap break-all ${
                      isDestroy
                        ? "text-[#FFA8A8] font-medium"
                        : isError
                        ? "text-[#FF8787] font-semibold"
                        : isSuccess
                        ? "text-[#4EBA87] font-semibold"
                        : isWarn
                        ? "text-[#FCD34D]"
                        : "text-[#E6E6E6]"
                    }`}
                  >
                    {log.message}
                  </span>
                </div>
              );
            })
          )}
          <div ref={logsEndRef} />
        </div>
      </Card>

      {/* Rollback Confirmation Modal */}
      {showRollbackModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#362217]/60 backdrop-blur-xs p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="rollback-dialog-title" className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl border border-[#EAE1D5] flex flex-col gap-4">
            <div className="flex items-center gap-3 text-[#6D28D9]">
              <div className="p-3 rounded-2xl bg-[#6D28D9]/10">
                <Undo2 className="h-6 w-6" />
              </div>
              <div>
                <h3 id="rollback-dialog-title" className="text-lg font-bold text-[#362217]">Rollback Deployment</h3>
                <p className="text-xs text-[#5E4C3E]">Restore previous stable service revision</p>
              </div>
            </div>

            <p className="text-xs text-[#5E4C3E] leading-relaxed">
              The rollback worker restores the compatible previous task definition (or S3 release), waits for ECS service stability and CloudFront invalidation as applicable, then verifies the live endpoint.
            </p>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="rollback-reason" className="text-xs font-bold text-[#362217]">Rollback Reason / Notes</label>
              <input
                type="text"
                id="rollback-reason"
                 value={rollbackReason}
                onChange={(e) => setRollbackReason(e.target.value)}
                className="w-full rounded-xl border border-[#DCD0C3] bg-white px-3 py-2 text-xs text-[#362217] outline-none focus:border-[#9E5D2D]"
                placeholder="Reason for rolling back..."
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRollbackModal(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleRollback}
                loading={rollingBack}
                className="bg-[#6D28D9] hover:bg-[#5B21B6] text-white font-bold"
              >
                Confirm Rollback
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* One-Click Destroy Confirmation Modal */}
      {showDestroyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#362217]/60 backdrop-blur-xs p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="destroy-dialog-title" className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl border border-[#EAE1D5] flex flex-col gap-5">
            <div className="flex items-center gap-3.5 text-[#9E2A2B]">
              <div className="p-3 rounded-2xl bg-[#9E2A2B]/10">
                <Flame className="h-6 w-6 text-[#9E2A2B]" />
              </div>
              <div>
                <h3 id="destroy-dialog-title" className="text-lg font-bold text-[#362217]">
                  One-Click AWS Infrastructure Teardown
                </h3>
                <p className="text-xs text-[#5E4C3E]">
                  Permanently delete all cloud services & prevent ongoing costs
                </p>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-[#9E2A2B]/5 border border-[#9E2A2B]/20 text-xs text-[#7E2223] flex flex-col gap-2">
              <span className="font-bold flex items-center gap-1.5 text-[#9E2A2B]">
                <AlertTriangle className="h-4 w-4" />
                Caution: Permanent Cloud Deletion via STS Role
              </span>
              <p className="text-[11px] leading-relaxed text-[#5E4C3E]">
                This will assume your connected IAM role (<strong>{awsData?.accountId || "Connected Account"}</strong> in <strong>{awsData?.region || "ap-south-1"}</strong>) and forcefully decommission every resource associated with this project:
              </p>
              <ul className="grid grid-cols-2 gap-1.5 mt-1 font-mono text-[10px] text-[#362217]">
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  ECS Fargate Cluster & Service
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  Application Load Balancer & TGs
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  ECR Repository & Docker Images
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  S3 Static Assets & Origin
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  CloudFront CDN Distribution
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  Project Security Groups (shared VPC retained)
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  CloudWatch Log Streams
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  Local Build Workspaces
                </li>
              </ul>
            </div>

            <div className="flex items-center justify-end gap-3 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowDestroyModal(false)}
                disabled={destroying}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleDestroy}
                loading={destroying}
                className="bg-[#9E2A2B] hover:bg-[#7E2223] text-white font-bold flex items-center gap-2"
              >
                <Trash2 className="h-4 w-4" />
                <span>Permanently Destroy All AWS Resources</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Direct AWS Credentials Input Modal */}
      {showAwsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#362217]/60 backdrop-blur-xs p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="aws-dialog-title" className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl border border-[#EAE1D5] flex flex-col gap-5">
            <div className="flex items-center justify-between border-b border-[#EADFCF] pb-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-[#9E5D2D] text-white">
                  <Key className="h-5 w-5" />
                </div>
                <div>
                  <h3 id="aws-dialog-title" className="text-lg font-bold text-[#362217]">
                    Connect AWS Account Credentials
                  </h3>
                  <p className="text-xs text-[#5E4C3E]">
                    Configure IAM Access Keys for deployment
                  </p>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close AWS credentials dialog"
                onClick={() => setShowAwsModal(false)}
                className="text-[#8C7667] hover:text-[#362217] p-1.5 rounded-lg hover:bg-[#FAF8F5] transition"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {awsModalNotice && (
              <div
                className={`p-3 rounded-xl border text-xs font-semibold flex items-center gap-2 ${
                  awsModalNotice.type === "success"
                    ? "bg-[#2E6B4F]/10 text-[#2E6B4F] border-[#2E6B4F]/20"
                    : "bg-[#9E2A2B]/10 text-[#9E2A2B] border-[#9E2A2B]/20"
                }`}
              >
                {awsModalNotice.type === "success" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0" />
                )}
                <span>{awsModalNotice.message}</span>
              </div>
            )}

            <form onSubmit={handleSaveAwsModalCredentials} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-[#5E4C3E]">
                  AWS Access Key ID
                </label>
                <div className="relative flex items-center">
                  <div className="pointer-events-none absolute left-3.5 text-[#8C7667]">
                    <Key className="h-4 w-4" />
                  </div>
                  <input
                    type="text"
                    placeholder="AKIAIOSFODNN7EXAMPLE"
                    value={awsAccessKeyInput}
                    onChange={(e) => setAwsAccessKeyInput(e.target.value)}
                    required
                    className="w-full rounded-xl border border-[#DCD0C3] bg-white pl-10 pr-4 py-2.5 text-xs font-mono text-[#362217] placeholder-[#A39284] outline-none transition focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-[#5E4C3E]">
                  AWS Secret Access Key
                </label>
                <div className="relative flex items-center">
                  <div className="pointer-events-none absolute left-3.5 text-[#8C7667]">
                    <Lock className="h-4 w-4" />
                  </div>
                  <input
                    type={showAwsSecret ? "text" : "password"}
                    placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                    value={awsSecretKeyInput}
                    onChange={(e) => setAwsSecretKeyInput(e.target.value)}
                    required
                    className="w-full rounded-xl border border-[#DCD0C3] bg-white pl-10 pr-10 py-2.5 text-xs font-mono text-[#362217] placeholder-[#A39284] outline-none transition focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]"
                  />
                  <button
                    type="button"
                    aria-label={showAwsSecret ? "Hide AWS secret access key" : "Show AWS secret access key"}
                    onClick={() => setShowAwsSecret(!showAwsSecret)}
                    className="absolute right-3 text-[#8C7667] hover:text-[#362217]"
                  >
                    {showAwsSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="aws-session-token" className="text-xs font-semibold text-[#5E4C3E]">
                  AWS Session Token (temporary credentials only)
                </label>
                <input
                  id="aws-session-token"
                  type={showAwsSecret ? "text" : "password"}
                  placeholder="Required for credentials issued by STS"
                  value={awsSessionTokenInput}
                  onChange={(event) => setAwsSessionTokenInput(event.target.value)}
                  autoComplete="off"
                  className="w-full rounded-xl border border-[#DCD0C3] bg-white px-4 py-2.5 text-xs font-mono text-[#362217] placeholder-[#A39284] outline-none transition focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="aws-modal-region" className="text-xs font-semibold text-[#5E4C3E]">
                  AWS Deployment Region
                </label>
                <select
                  id="aws-modal-region"
                  value={awsRegionInput}
                  onChange={(e) => setAwsRegionInput(e.target.value)}
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

              <p className="text-[11px] text-[#8C7667] leading-relaxed">
                Credentials are encrypted at rest and verified using AWS STS. They are used for the selected private S3/CloudFront or ECS deployment path.
              </p>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-[#EAE1D5]">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAwsModal(false)}
                  disabled={savingAwsKeys}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  loading={savingAwsKeys}
                  className="bg-[#2E6B4F] hover:bg-[#24543D] text-white font-bold flex items-center gap-1.5"
                >
                  <ShieldCheck className="h-4 w-4" />
                  Save & Verify AWS Keys
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
