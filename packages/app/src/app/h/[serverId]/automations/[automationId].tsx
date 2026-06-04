import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AutomationDetailScreen } from "@/screens/automations/automation-detail-screen";

export default function HostAutomationDetailRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostAutomationDetailRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostAutomationDetailRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string; automationId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const automationId = typeof params.automationId === "string" ? params.automationId : "";

  return <AutomationDetailScreen serverId={serverId} automationId={automationId} />;
}
