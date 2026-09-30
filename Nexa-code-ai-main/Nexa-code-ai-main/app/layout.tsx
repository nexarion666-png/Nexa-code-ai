import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Nexa Code',
  description: 'Build. Fix. Ship.',
  manifest: '/manifest.json',
  themeColor: '#0a0a0a',
  appleWebApp: { capable: true, title: 'Nexa', statusBarStyle: 'black-translucent' },
  icons: { icon: '/icon-512.png', apple: '/icon-512.png' }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
