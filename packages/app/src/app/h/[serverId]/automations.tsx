import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AutomationsListScreen } from "@/screens/automations/automations-list-screen";

export default function HostAutomationsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostAutomationsRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostAutomationsRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";

  return <AutomationsListScreen serverId={serverId} />;
}
