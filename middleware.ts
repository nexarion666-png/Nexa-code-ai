import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
export function middleware(req: NextRequest){const res=NextResponse.next();res.headers.set('X-Content-Type-Options','nosniff');res.headers.set('Referrer-Policy','strict-origin-when-cross-origin');res.headers.set('X-Frame-Options','DENY');res.headers.set('Permissions-Policy','camera=(),microphone=(),geolocation=()');if(process.env.NODE_ENV==='production')res.headers.set('Strict-Transport-Security','max-age=31536000; includeSubDomains');return res}
export const config={matcher:['/((?!_next/static|_next/image|favicon.ico).*)']};
