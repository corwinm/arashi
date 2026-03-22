import { hasMinimumColumns } from "./terminal-context.ts";

type TerminalContext = Parameters<typeof hasMinimumColumns>[0];

export const FULL_LOGO_TEXT = [
  "◢▲◣  ▓█▀█  ▓█▀▄  ▓█▀█  ▓█▀▀  ▓█░█  ▓█",
  "◥▲◤  ▓█▀█  ▓█▀▄  ▓█▀█  ▓▀▀█  ▓█▀█  ▓█",
  "     ▓▀░▀  ▓▀░▀  ▓▀░▀  ▀▀▀▀  ▓▀░▀  ▓▀",
].join("\n");

export const COMPACT_LOGO_TEXT = ["◢▲◣", "◥▲◤"].join("\n");

export const PLAIN_LOGO_TEXT = "arashi";

export const LOGO_FAMILY_RULES = {
  compact: {
    maxColumns: 12,
    maxLines: 2,
    minTerminalColumns: 60,
  },
  full: {
    maxColumns: 52,
    maxLines: 3,
    minTerminalColumns: 100,
  },
} as const;

export type HelpBannerVariant = "full" | "compact" | "plain";

export function selectHelpBannerVariant(context: TerminalContext): HelpBannerVariant {
  if (!context.isInteractive) {
    return "plain";
  }

  if (hasMinimumColumns(context, LOGO_FAMILY_RULES.full.minTerminalColumns)) {
    return "full";
  }

  if (hasMinimumColumns(context, LOGO_FAMILY_RULES.compact.minTerminalColumns)) {
    return "compact";
  }

  return "plain";
}

export function getLogoText(variant: HelpBannerVariant): string {
  switch (variant) {
    case "full": {
      return FULL_LOGO_TEXT;
    }
    case "compact": {
      return COMPACT_LOGO_TEXT;
    }
    case "plain": {
      return PLAIN_LOGO_TEXT;
    }
  }
}

export function renderHelpBanner(context: TerminalContext): string {
  const selected = selectHelpBannerVariant(context);
  return `${getLogoText(selected)}\n`;
}
