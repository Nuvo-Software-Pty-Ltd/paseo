import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import type { AutomationKind } from "@/lib/automations/automation-model";
import { AutomationDetailScreen } from "@/screens/automations/automation-detail-screen";

export default function HostAutomationDetailRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostAutomationDetailRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function parseKind(value: unknown): AutomationKind | undefined {
  return value === "schedule" || value === "webhook" ? value : undefined;
}

function HostAutomationDetailRouteContent() {
  const params = useLocalSearchParams<{
    serverId?: string;
    automationId?: string;
    kind?: string;
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const automationId = typeof params.automationId === "string" ? params.automationId : "";
  const kind = parseKind(params.kind);

  return <AutomationDetailScreen serverId={serverId} automationId={automationId} kind={kind} />;
}
