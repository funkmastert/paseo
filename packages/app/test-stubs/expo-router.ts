import type { ReactNode } from "react";

function noop(): void {}

export const router = {
  push: noop,
  replace: noop,
  back: noop,
  canGoBack: () => false,
  navigate: noop,
  dismissTo: noop,
};

export function useRouter() {
  return router;
}

export function usePathname(): string {
  return "";
}

export function useLocalSearchParams(): Record<string, string> {
  return {};
}

export function useGlobalSearchParams(): Record<string, string> {
  return {};
}

export function useRootNavigationState(): undefined {
  return undefined;
}

export function useNavigationContainerRef() {
  return { current: null };
}

export function Redirect(): null {
  return null;
}

export function Stack({ children }: { children?: ReactNode }): ReactNode {
  return children ?? null;
}
Stack.Screen = function StackScreen(): null {
  return null;
};
Stack.Protected = function StackProtected({ children }: { children?: ReactNode }): ReactNode {
  return children ?? null;
};
