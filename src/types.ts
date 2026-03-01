
export interface NodeAgent {
  id: string;
  hostname: string;
  ip: string;
  status: 'online' | 'offline' | 'degraded';
  gpuTemp: number;
  vramUsed: number;
  vramTotal: number;
  powerUsage: number;
  tdp?: number; // Thermal Design Power in Watts
  requestsPerSecond: number;
  activeInterceptors: string[];
  uptime: string;
  sentinelActive?: boolean;
}

export interface TraceRecord {
  id: string;
  timestamp: string;
  nodeId: string;
  model: string;
  latency: number;
  ttft: number; // Time to First Token
  tpot: number; // Time Per Output Token
  status: number;
}

export type UserRole = 'Owner' | 'Collaborator' | 'Viewer';

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  isPro?: boolean;
}

export interface Tenant {
  id: string;
  name: string;
}

export enum DashboardTab {
  OVERVIEW = 'overview',
  NODES = 'nodes',
  TRACES = 'traces',
  SCAFFOLDING = 'scaffolding',
  AI_INSIGHTS = 'ai_insights',
  TEAM = 'team',
  SUSTAINABILITY = 'sustainability',
  PROFILE = 'profile',
  SECURITY = 'security',
  API_KEYS = 'api_keys',
  PREFERENCES = 'preferences',
  PRICING = 'pricing',
  AI_PROVIDERS = 'ai_providers',
  BILLING = 'billing'
}
