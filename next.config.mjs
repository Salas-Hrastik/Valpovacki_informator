/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse je CommonJS paket koji se ne smije bundlati u server build
  experimental: {
    serverComponentsExternalPackages: ['pdf-parse'],
  },
  async headers() {
    return [
      {
        // Widget se ugrađuje na gradsko web sjedište putem iframea —
        // dopuštamo uokvirivanje SAMO sa službenih domena (prilagodite po potrebi).
        source: '/widget',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' https://valpovo.hr https://*.valpovo.hr",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
