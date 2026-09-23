import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        ink: '#09090b',
        card: '#18181b',
        line: '#27272a',
        purple: '#8b5cf6',
        neon: '#39ff88'
      },
      boxShadow: {
        glow: '0 0 28px rgba(139,92,246,.35)',
        green: '0 0 22px rgba(57,255,136,.2)'
      }
    }
  },
  plugins: []
};

export default config;
