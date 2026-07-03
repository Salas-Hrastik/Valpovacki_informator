/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // pdf-parse je CommonJS paket koji se ne smije bundlati u server build
    serverComponentsExternalPackages: ['pdf-parse'],
    // Datoteke knjige (knowledge/) moraju ući u deployment paket da ih
    // /api/ingest može pročitati i na Vercelu (fs čita s diska funkcije).
    outputFileTracingIncludes: {
      '/api/ingest': ['./knowledge/**/*'],
    },
  },
  async headers() {
    return [
      {
        // Widget se ugrađuje na vanjsko web sjedište putem iframea —
        // dopuštamo uokvirivanje SAMO s navedenih domena (prilagodite po potrebi).
        source: '/widget',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
