// Marks a container so session replay redacts its text. Spread onto the outer
// View of panes that render code / terminal / agent output:
//   <View {...maskPaneProps()}>…</View>
//
// Web: react-native-web renders `dataSet` as `data-*` attributes, which
// posthog-js targets via WEB_MASK_SELECTOR ('[data-ph-mask]'). Native: no-op for
// now (per-view replay masking on iOS is a follow-up; the native baseline masks
// all text inputs + images — see analytics.ts).

import type { ViewProps } from "react-native";
import { isWeb } from "@/constants/platform";

export function maskPaneProps(): Partial<ViewProps> {
  if (!isWeb) return {};
  return { dataSet: { phMask: "true" } } as Partial<ViewProps>;
}
