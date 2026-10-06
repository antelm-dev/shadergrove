import type { Metadata } from 'next';
import { Downloads } from '@/components/releases/downloads';

export const metadata: Metadata = {
  title: 'Download Shadergrove',
  description: 'Download the latest Shadergrove desktop release for Windows, Linux or macOS.',
};

export default function DownloadPage() {
  return <Downloads />;
}
