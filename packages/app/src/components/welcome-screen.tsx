import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, ScrollView } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { QrCode, Link2, ClipboardPaste, ExternalLink, Settings, Cloud } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HostProfile } from "@/types/host-connection";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
import { resolveWelcomeRedirectServerId } from "./welcome-redirect";
import { AddHostModal } from "./add-host-modal";
import { PairLinkModal } from "./pair-link-modal";
import { Button } from "@/components/ui/button";
import { resolveAppVersion } from "@/utils/app-version";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { buildHostRootRoute } from "@/utils/host-routes";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { openExternalUrl } from "@/utils/open-external-url";
import { isWeb, isNative } from "@/constants/platform";
import { isSelfHostConnectionsEnabled } from "@/constants/feature-flags";
import { filterWelcomeActions, type WelcomeActionKey } from "./welcome-actions";
import { loginWithOrchestra } from "@/lib/orchestra-cloud-client";

interface WelcomeAction {
  key: WelcomeActionKey;
  label: string;
  testID: string;
  primary: boolean;
  icon: typeof QrCode;
  onPress: () => void;
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    padding: theme.spacing[6],
    paddingBottom: 0,
    alignItems: "center",
  },
  content: {
    width: "100%",
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  copyBlock: {
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[12],
  },
  actions: {
    width: "100%",
    maxWidth: 420,
    gap: theme.spacing[3],
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionButtonPrimary: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  actionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  actionTextPrimary: {
    color: theme.colors.accentForeground,
  },
  setupLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  setupLinkText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  versionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    marginTop: theme.spacing[6],
  },
  settingsButton: {
    alignSelf: "center",
    marginTop: theme.spacing[6],
  },
  sessionExpiredBanner: {
    width: "100%",
    maxWidth: 420,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    marginBottom: theme.spacing[3],
  },
  sessionExpiredBannerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

function useAnyHostOnline(serverIds: string[]): string | null {
  const runtime = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => {
      let firstOnlineServerId: string | null = null;
      let firstOnlineAt: string | null = null;
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId);
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null;
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue;
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt;
          firstOnlineServerId = serverId;
        }
      }
      return firstOnlineServerId;
    },
    () => {
      let firstOnlineServerId: string | null = null;
      let firstOnlineAt: string | null = null;
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId);
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null;
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue;
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt;
          firstOnlineServerId = serverId;
        }
      }
      return firstOnlineServerId;
    },
  );
}

export interface WelcomeScreenProps {
  onHostAdded?: (profile: HostProfile) => void;
}

export const SESSION_EXPIRED_BANNER_COPY = "Your session expired. Sign in again to continue.";

export function WelcomeScreen({ onHostAdded }: WelcomeScreenProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionWithPrefix(appVersion);
  const params = useLocalSearchParams<{ reason?: string | string[] }>();
  const reason = Array.isArray(params.reason) ? params.reason[0] : params.reason;
  const showSessionExpiredBanner = reason === "session-expired";
  const [isDirectOpen, setIsDirectOpen] = useState(false);
  const [isPasteLinkOpen, setIsPasteLinkOpen] = useState(false);
  const hosts = useHosts();
  const anyOnlineServerId = useAnyHostOnline(hosts.map((h) => h.serverId));

  useEffect(() => {
    const redirectServerId = resolveWelcomeRedirectServerId({
      anyOnlineServerId,
      hosts,
      isWeb,
    });
    if (!redirectServerId) return;
    router.replace(buildHostRootRoute(redirectServerId));
  }, [anyOnlineServerId, hosts, router]);

  const finishOnboarding = useCallback(
    (serverId: string) => {
      router.replace(buildHostRootRoute(serverId));
    },
    [router],
  );

  const handleOpenPaseoSite = useCallback(() => {
    void openExternalUrl("https://paseo.sh");
  }, []);

  const handleOpenSettings = useCallback(() => {
    router.push("/settings");
  }, [router]);

  const handleOpenDirect = useCallback(() => setIsDirectOpen(true), []);
  const handleCloseDirect = useCallback(() => setIsDirectOpen(false), []);
  const handleOpenPasteLink = useCallback(() => setIsPasteLinkOpen(true), []);
  const handleClosePasteLink = useCallback(() => setIsPasteLinkOpen(false), []);
  const handleScanQr = useCallback(() => {
    router.push("/pair-scan?source=onboarding");
  }, [router]);

  const handleConnectOrchestra = useCallback(() => {
    void loginWithOrchestra()
      .then(() => {
        router.push("/orchestra/setup");
        return undefined;
      })
      .catch((error) => {
        console.warn("[Welcome] Orchestra OAuth failed:", error);
      });
  }, [router]);

  const handleHostSaved = useCallback(
    ({ profile, serverId }: { profile: HostProfile; serverId: string }) => {
      onHostAdded?.(profile);
      finishOnboarding(serverId);
    },
    [onHostAdded, finishOnboarding],
  );

  const actions: WelcomeAction[] = isWeb
    ? [
        {
          key: "orchestra-cloud",
          label: "Connect to Orchestra",
          testID: "welcome-orchestra-cloud",
          primary: true,
          icon: Cloud,
          onPress: handleConnectOrchestra,
        },
        {
          key: "direct-connection",
          label: t("pairing.connectionMethods.direct.title"),
          testID: "welcome-direct-connection",
          primary: false,
          icon: Link2,
          onPress: handleOpenDirect,
        },
        {
          key: "paste-pairing-link",
          label: t("pairing.connectionMethods.pasteLink.title"),
          testID: "welcome-paste-pairing-link",
          primary: false,
          icon: ClipboardPaste,
          onPress: handleOpenPasteLink,
        },
      ]
    : [
        // "Connect to Orchestra" is the primary CTA on native too, mirroring
        // web. On a native cloud build (EXPO_PUBLIC_SELF_HOST_ENABLED="false")
        // filterWelcomeActions drops the self-host actions below, leaving this
        // as the only action — so it must stay outside the self-host set.
        {
          key: "orchestra-cloud",
          label: "Connect to Orchestra",
          testID: "welcome-orchestra-cloud",
          primary: true,
          icon: Cloud,
          onPress: handleConnectOrchestra,
        },
        {
          key: "scan-qr",
          label: t("pairing.connectionMethods.scanQr.title"),
          testID: "welcome-scan-qr",
          primary: false,
          icon: QrCode,
          onPress: handleScanQr,
        },
        {
          key: "direct-connection",
          label: t("pairing.connectionMethods.direct.title"),
          testID: "welcome-direct-connection",
          primary: false,
          icon: Link2,
          onPress: handleOpenDirect,
        },
        {
          key: "paste-pairing-link",
          label: t("pairing.connectionMethods.pasteLink.title"),
          testID: "welcome-paste-pairing-link",
          primary: false,
          icon: ClipboardPaste,
          onPress: handleOpenPasteLink,
        },
      ];

  // `actions` is rebuilt each render (as it always was), so filter inline —
  // memoizing on it would never hit the cache.
  const visibleActions = filterWelcomeActions(actions, isSelfHostConnectionsEnabled());

  const scrollContentContainerStyle = useMemo(
    () => [styles.container, { paddingBottom: theme.spacing[6] + insets.bottom }],
    [theme.spacing, insets.bottom],
  );

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={scrollContentContainerStyle}
        showsVerticalScrollIndicator={false}
        testID="welcome-screen"
      >
        <View style={styles.content}>
          <PaseoLogo size={96} />
          <View style={styles.copyBlock}>
            <Text style={styles.title}>{t("onboarding.title")}</Text>
            <Text style={styles.subtitle}>{t("onboarding.subtitle")}</Text>
            {isNative ? (
              <Pressable style={styles.setupLink} onPress={handleOpenPaseoSite}>
                <Text style={styles.setupLinkText}>paseo.sh</Text>
                <ExternalLink size={14} color={theme.colors.accent} />
              </Pressable>
            ) : null}
          </View>

          {showSessionExpiredBanner ? (
            <View style={styles.sessionExpiredBanner} testID="welcome-session-expired-banner">
              <Text style={styles.sessionExpiredBannerText}>{SESSION_EXPIRED_BANNER_COPY}</Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            {visibleActions.map((action) => (
              <WelcomeActionButton key={action.key} action={action} />
            ))}
          </View>

          <Button
            variant="ghost"
            size="sm"
            leftIcon={Settings}
            onPress={handleOpenSettings}
            style={styles.settingsButton}
            testID="welcome-open-settings"
          >
            {t("onboarding.actions.settings")}
          </Button>
        </View>
        <Text style={styles.versionLabel}>{appVersionText}</Text>

        <AddHostModal
          visible={isDirectOpen}
          onClose={handleCloseDirect}
          onSaved={handleHostSaved}
        />

        <PairLinkModal
          visible={isPasteLinkOpen}
          onClose={handleClosePasteLink}
          onSaved={handleHostSaved}
        />
      </ScrollView>
    </View>
  );
}

interface WelcomeActionButtonProps {
  action: WelcomeAction;
}

function WelcomeActionButton({ action }: WelcomeActionButtonProps) {
  const { theme } = useUnistyles();
  const Icon = action.icon;
  const buttonStyle = useMemo(
    () => [styles.actionButton, action.primary ? styles.actionButtonPrimary : null],
    [action.primary],
  );
  const textStyle = useMemo(
    () => [styles.actionText, action.primary ? styles.actionTextPrimary : null],
    [action.primary],
  );
  return (
    <Pressable style={buttonStyle} onPress={action.onPress} testID={action.testID}>
      <Icon
        size={18}
        color={action.primary ? theme.colors.accentForeground : theme.colors.foreground}
      />
      <Text style={textStyle}>{action.label}</Text>
    </Pressable>
  );
}
