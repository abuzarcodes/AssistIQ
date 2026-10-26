import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { ThemeProvider } from "@/lib/theme-context";
import { ToastProvider } from "@/components/ui/toast";
import { ApiErrorBridge } from "@/components/api-error-bridge";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AssistIQ — AI Customer Support",
  description:
    "AI-powered customer support platform with intelligent conversation routing, knowledge management, and ML-driven intent classification.",
};

/**
 * Applies the saved theme before the browser paints the first frame.
 *
 * This runs in <head>, so a dark-screen user never sees a white flash while React
 * hydrates. It is deliberately tiny and duplicated only in `lib/theme-context.tsx`,
 * which owns every change after hydration.
 */
const themeInitScript = `
(function () {
  try {
    var mode = localStorage.getItem('assistiq_theme');
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') mode = 'system';
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var resolved = mode === 'system' ? (dark ? 'dark' : 'light') : mode;
    var root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    root.style.colorScheme = resolved;
  } catch (error) {}
})();
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <AuthProvider>
            <ToastProvider>
              <ApiErrorBridge />
              {children}
            </ToastProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
