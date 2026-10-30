import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SwRegister } from '@/components/SwRegister';

export const metadata: Metadata = {
  title: 'SolWatch-1U Mission Control',
  description:
    'Ground-station dashboard for SolWatch-1U, a 1U CubeSat that detects dust and dew on UAE solar farms. SatForge UAE 2026 — Team Najm Innovators.',
  icons: { icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M20 4 34 11v16l-14 7-14-7V11z" fill="%2338bdf8"/><circle cx="32" cy="7" r="5" fill="%23fbbf24"/></svg>' },
};

export const viewport: Viewport = {
  themeColor: '#060a14',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
