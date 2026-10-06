import type { Metadata } from 'next';
import { Changelog } from '@/components/releases/changelog';

export const metadata: Metadata = {
  title: 'Shadergrove changelog',
  description: 'Explore the latest Shadergrove releases, improvements and fixes.',
};

export default function ChangelogPage() {
  return <Changelog />;
}
