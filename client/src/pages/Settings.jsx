import { useState, useEffect, useContext } from "react";
import { AuthContext } from "../context/AuthContext";
import Card from "../components/Card";
import Button from "../components/Button";
import Input from "../components/Input";
import { User, Mail, Key, Save, Check } from "lucide-react";

export default function Settings() {
  const { user } = useContext(AuthContext);
  const [name, setName] = useState(user?.name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [awsRole, setAwsRole] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (user) {
      if (user.name) setName(user.name);
      if (user.email) setEmail(user.email);
    }
  }, [user]);

  const handleSave = (e) => {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="flex flex-col gap-6 w-full max-w-4xl text-[#362217]">
      {/* Page Header */}
      <div>
        <h2 className="text-2xl font-bold text-[#362217]">Account & Cloud Settings</h2>
        <p className="text-xs text-[#5E4C3E] mt-1">Manage profile parameters, API tokens, and AWS IAM integrations</p>
      </div>

      {saved && (
        <div className="flex items-center gap-3 rounded-xl border border-[#2E6B4F]/30 bg-[#2E6B4F]/10 p-4 text-xs text-[#2E6B4F] font-semibold">
          <Check className="h-4 w-4 shrink-0" />
          <span>Settings updated successfully!</span>
        </div>
      )}

      {/* Profile Form */}
      <Card glow={false} className="flex flex-col gap-6 bg-white border border-[#EAE1D5]">
        <h3 className="text-base font-bold text-[#362217] border-b border-[#EADFCF] pb-3">User Profile</h3>
        <form onSubmit={handleSave} className="flex flex-col gap-4">
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

          <h3 className="text-base font-bold text-[#362217] border-b border-[#EADFCF] pb-3 mt-4">
            AWS IAM Integration
          </h3>
          <Input
            label="AWS Cross-Account Role ARN"
            icon={Key}
            placeholder="arn:aws:iam::123456789012:role/SkyForgeRole"
            value={awsRole}
            onChange={(e) => setAwsRole(e.target.value)}
          />
          <p className="text-[11px] text-[#8C7667]">
            SkyForge uses Role-based STS tokens to manage your cloud resources securely without access keys.
          </p>

          <div className="pt-4 flex justify-end">
            <Button type="submit" icon={Save} size="sm">
              Save Changes
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
