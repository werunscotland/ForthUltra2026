import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { toPng } from 'html-to-image';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';

// Fix Leaflet marker icons
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  Cell, ComposedChart, Line, ScatterChart, Scatter, ZAxis, PieChart, Pie,
  LineChart, LabelList
} from 'recharts';
import { 
  Activity, 
  Users, 
  Trophy, 
  MapPin, 
  Upload, 
  Filter, 
  Download,
  AlertCircle,
  Clock,
  TrendingUp,
  BarChart2,
  PieChart as PieChartIcon,
  Zap,
  ChevronRight,
  X,
  ArrowUp,
  ArrowDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { ProcessedRaceResult, RaceResult, DashboardStats } from './types';

// --- UTILITIES ---

const timeToSeconds = (timeStr: string): number => {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
};

const formatSecondsToHHMM = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
};

const formatSecondsToHHMMSS = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const PANTONE_COLORS = ["#2563eb", "#10b981", "#f59e0b", "#6366f1", "#71717a", "#ec4899"];

// --- COMPONENTS ---

const StatCard = ({ title, value, icon: Icon, color, subtext }: { title: string, value: string | number, icon: any, color: string, subtext?: string }) => (
  <div className="bg-zinc-900/80 border border-zinc-800 p-3 rounded group hover:border-zinc-700 transition-colors">
    <div className="flex items-center justify-between mb-1">
      <div className="text-[10px] text-zinc-500 uppercase font-mono tracking-wider">{title}</div>
      <Icon className={cn("w-3.5 h-3.5", color.replace('bg-', 'text-'))} />
    </div>
    <div className="text-xl font-semibold text-zinc-100">{value}</div>
    {subtext && (
      <div className="mt-1 text-[10px] text-zinc-500 italic truncate">{subtext}</div>
    )}
  </div>
);

export default function App() {
  const [data, setData] = useState<ProcessedRaceResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [eventFilter, setEventFilter] = useState('All');
  const [genderFilter, setGenderFilter] = useState('All');
  const [categoryFilter, setCategoryFilter] = useState('All');

  const [activeTab, setActiveTab] = useState<'TRAFFIC' | 'PERFORMANCE' | 'DEMOGRAPHICS' | 'ROUTE' | 'LEADERBOARD'>('TRAFFIC');
  const [gsheetUrl, setGsheetUrl] = useState('');
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [selectedAthlete, setSelectedAthlete] = useState<ProcessedRaceResult | null>(null);
  const [activeSegments, setActiveSegments] = useState<string[]>(['CP1', 'CP2', 'CP3', 'FINISH']);
  const athleteModalRef = useRef<HTMLDivElement>(null);

  // Auto-fetch data on mount from Google Sheets (Streaming multiple tabs)
  useEffect(() => {
    const sheetId = '1Ll4ZrJRzJfSmv-LI40wc2kqPms1AZQxxT7DSPboGSMY';
    
    const fetchTab = async (tabName: string, eventType: 'Individual' | 'Team of 2' | 'Team of 4') => {
      // Using the Google Visualization query endpoint which allows named sheet access
      const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const csvText = await response.text();
        
        return new Promise<ProcessedRaceResult[]>((resolve) => {
          Papa.parse(csvText, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
              const rawData = results.data as RaceResult[];
              resolve(processRawData(rawData, tabName.toUpperCase(), eventType));
            },
            error: (err) => {
              addLog('ERROR', `Parsing ${tabName} failed: ${err.message}`);
              resolve([]);
            }
          });
        });
      } catch (err) {
        addLog('ERROR', `Fetch ${tabName} failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    };

    const syncAllTabs = async () => {
      setIsLoading(true);
      addLog('INFO', 'Initiating Google_Drive_Secure_Multi_Stream...');
      
      try {
        const individualPromise = fetchTab('Individual', 'Individual');
        const team2Promise = fetchTab('Team of 2', 'Team of 2');
        const team4Promise = fetchTab('Team of 4', 'Team of 4');

        const [individualData, team2Data, team4Data] = await Promise.all([
          individualPromise,
          team2Promise,
          team4Promise
        ]);

        const combinedData = [...individualData, ...team2Data, ...team4Data];

        if (combinedData.length === 0) {
          setIsLoading(false);
          addLog('ERROR', 'Stream sync complete but no valid records found.');
          return;
        }

        // Calculate Ranks across the entire unified dataset
        const calculateRanks = (resultsData: ProcessedRaceResult[]) => {
          // Note: Ranking should be calculated per event category for accurate leaderboards
          const events: ('Individual' | 'Team of 2' | 'Team of 4')[] = ['Individual', 'Team of 2', 'Team of 4'];
          
          const rankedData = events.flatMap(ev => {
            const evData = resultsData.filter(r => r.Event === ev);
            if (evData.length === 0) return [];

            const cp1Sorted = [...evData].sort((a,b) => (a.arrivalCP1 || Infinity) - (b.arrivalCP1 || Infinity));
            const cp2Sorted = [...evData].sort((a,b) => (a.arrivalCP2 || Infinity) - (b.arrivalCP2 || Infinity));
            const cp3Sorted = [...evData].sort((a,b) => (a.arrivalCP3 || Infinity) - (b.arrivalCP3 || Infinity));
            const finSorted = [...evData].sort((a,b) => (a.arrivalFinish || Infinity) - (b.arrivalFinish || Infinity));

            return evData.map(r => ({
              ...r,
              rankCP1: cp1Sorted.findIndex(x => x.id === r.id) + 1,
              rankCP2: cp2Sorted.findIndex(x => x.id === r.id) + 1,
              rankCP3: cp3Sorted.findIndex(x => x.id === r.id) + 1,
              rankFinish: finSorted.findIndex(x => x.id === r.id) + 1,
            }));
          });

          return rankedData;
        };

        setData(calculateRanks(combinedData));
        addLog('READY', `Cloud_Multi_Stream_Synced: ${combinedData.length} total participants active.`);
      } catch (err) {
        addLog('ERROR', 'Global sync pipeline failure.');
      } finally {
        setIsLoading(false);
      }
    };

    syncAllTabs();
  }, []);

  const handleLegendClick = (payload: any) => {
    const { value } = payload;
    setActiveSegments(prev => {
      // If it's already soloed, reset to all
      if (prev.length === 1 && prev.includes(value)) {
        return ['CP1', 'CP2', 'CP3', 'FINISH'];
      }
      // Otherwise solo it
      return [value];
    });
  };

  const handleDownloadPng = async () => {
    if (!athleteModalRef.current || !selectedAthlete) return;
    
    try {
      const dataUrl = await toPng(athleteModalRef.current, {
        backgroundColor: '#09090b', // zinc-950
        pixelRatio: 2, // Better resolution
        filter: (node) => {
          if (node.hasAttribute && node.hasAttribute('data-html2canvas-ignore')) {
            return false;
          }
          return true;
        }
      });
      
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `${selectedAthlete.Name.replace(/\s+/g, '_')}_results.png`;
      a.click();
    } catch (err) {
      console.error("Failed to generate image", err);
    }
  };

  const [sortConfig, setSortConfig] = useState<{ key: keyof ProcessedRaceResult; direction: 'asc' | 'desc' }>({ 
    key: 'totalTimeSec', 
    direction: 'asc' 
  });

  const [logs, setLogs] = useState<{ time: string, type: 'INFO' | 'WARN' | 'READY' | 'ERROR', msg: string }[]>([
    { time: new Date().toLocaleTimeString(), type: 'INFO', msg: 'System initializing...' },
    { time: new Date().toLocaleTimeString(), type: 'INFO', msg: 'Backend persona mounted: 0x92f...a1' },
    { time: new Date().toLocaleTimeString(), type: 'WARN', msg: 'Awaiting source stream input (CSV/XLSX/G-SHEET).' }
  ]);

  const addLog = (type: 'INFO' | 'WARN' | 'READY' | 'ERROR', msg: string) => {
    setLogs(prev => [...prev.slice(-19), { time: new Date().toLocaleTimeString(), type, msg }]);
  };

  const processRawData = (rawData: any[], sourceId: string, eventTypeHint: 'Individual' | 'Team of 2' | 'Team of 4') => {
    if (rawData.length === 0) return [];
    
    // Integrity Check: Header Verification
    const firstRow = rawData[0];
    const requiredHeaders = ['Time', 'Name', 'Culross (CP1)', 'Ferrymuir Gate (CP2)', 'Boness (CP3)', 'Finish'];
    const missing = requiredHeaders.filter(h => !(h in firstRow));
    
    if (missing.length > 0) {
      addLog('ERROR', `Schema Mismatch in ${sourceId}: Missing [${missing.join(', ')}]`);
      return [];
    }

    const processed = rawData
      .filter(r => r.Time && r.Name)
      .map((r, idx) => {
        const arrivalCP1 = timeToSeconds(r['Culross (CP1)']);
        const arrivalCP2 = arrivalCP1 + timeToSeconds(r['Ferrymuir Gate (CP2)']);
        const arrivalCP3 = arrivalCP2 + timeToSeconds(r['Boness (CP3)']);
        const arrivalFinish = arrivalCP3 + timeToSeconds(r.Finish);
        
        // Data Integrity: Check if splits are valid numbers
        if (isNaN(arrivalFinish) || arrivalFinish === 0) {
          return null;
        }

        return {
          ...r,
          id: `${sourceId}-${idx}-${r.Name}`,
          Event: eventTypeHint,
          arrivalCP1,
          arrivalCP2,
          arrivalCP3,
          arrivalFinish,
          totalTimeSec: arrivalFinish
        } as ProcessedRaceResult;
      })
      .filter((r): r is ProcessedRaceResult => r !== null);

    addLog('READY', `Ingested ${processed.length} records from ${sourceId}`);
    return processed;
  };

  const onFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    setIsLoading(true);
    setError(null);
    const allProcessedData: ProcessedRaceResult[] = [];
    let processedFilesCount = 0;

    const finalize = () => {
      processedFilesCount++;
      if (processedFilesCount === files.length) {
        // Calculate Ranks
        const calculateRanks = (data: ProcessedRaceResult[]) => {
          const cp1Sorted = [...data].sort((a,b) => (a.arrivalCP1 || Infinity) - (b.arrivalCP1 || Infinity));
          const cp2Sorted = [...data].sort((a,b) => (a.arrivalCP2 || Infinity) - (b.arrivalCP2 || Infinity));
          const cp3Sorted = [...data].sort((a,b) => (a.arrivalCP3 || Infinity) - (b.arrivalCP3 || Infinity));
          const finSorted = [...data].sort((a,b) => (a.arrivalFinish || Infinity) - (b.arrivalFinish || Infinity));

          return data.map(r => ({
            ...r,
            rankCP1: cp1Sorted.findIndex(x => x.id === r.id) + 1,
            rankCP2: cp2Sorted.findIndex(x => x.id === r.id) + 1,
            rankCP3: cp3Sorted.findIndex(x => x.id === r.id) + 1,
            rankFinish: finSorted.findIndex(x => x.id === r.id) + 1,
          }));
        };

        setData(prev => calculateRanks([...prev, ...allProcessedData]));
        setIsLoading(false);
      }
    };

    (Array.from(files) as File[]).forEach(file => {
      if (file.name.endsWith('.csv')) {
        let eventType: 'Individual' | 'Team of 2' | 'Team of 4' = 'Individual';
        if (file.name.includes('Team of 2')) eventType = 'Team of 2';
        else if (file.name.includes('Team of 4')) eventType = 'Team of 4';

        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            const rawData = results.data as RaceResult[];
            const processed = rawData
              .filter(r => r.Time && r.Name)
              .map((r, idx) => {
                const arrivalCP1 = timeToSeconds(r['Culross (CP1)']);
                const arrivalCP2 = arrivalCP1 + timeToSeconds(r['Ferrymuir Gate (CP2)']);
                const arrivalCP3 = arrivalCP2 + timeToSeconds(r['Boness (CP3)']);
                const arrivalFinish = arrivalCP3 + timeToSeconds(r.Finish);
                
                return {
                  ...r,
                  id: `csv-${file.name}-${idx}-${r.Name}`,
                  Event: eventType,
                  arrivalCP1,
                  arrivalCP2,
                  arrivalCP3,
                  arrivalFinish,
                  totalTimeSec: arrivalFinish
                } as ProcessedRaceResult;
              });
            allProcessedData.push(...processed);
            finalize();
          },
          error: (err) => {
            setError(`Error parsing ${file.name}: ${err.message}`);
            finalize();
          }
        });
      } else if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const ab = e.target?.result;
            const wb = XLSX.read(ab, { type: 'array' });
            
            wb.SheetNames.forEach(sheetName => {
              const ws = wb.Sheets[sheetName];
              const rawData = XLSX.utils.sheet_to_json(ws) as RaceResult[];
              
              let eventType: 'Individual' | 'Team of 2' | 'Team of 4' = 'Individual';
              if (sheetName.includes('2') || file.name.includes('2')) eventType = 'Team of 2';
              else if (sheetName.includes('4') || file.name.includes('4')) eventType = 'Team of 4';

              const processed = rawData
                .filter(r => r.Time && r.Name)
                .map((r, idx) => {
                  const arrivalCP1 = timeToSeconds(r['Culross (CP1)']);
                  const arrivalCP2 = arrivalCP1 + timeToSeconds(r['Ferrymuir Gate (CP2)']);
                  const arrivalCP3 = arrivalCP2 + timeToSeconds(r['Boness (CP3)']);
                  const arrivalFinish = arrivalCP3 + timeToSeconds(r.Finish);
                  
                  return {
                    ...r,
                    id: `xlsx-${file.name}-${sheetName}-${idx}-${r.Name}`,
                    Event: eventType,
                    arrivalCP1,
                    arrivalCP2,
                    arrivalCP3,
                    arrivalFinish,
                    totalTimeSec: arrivalFinish
                  } as ProcessedRaceResult;
                });
              allProcessedData.push(...processed);
            });
            finalize();
          } catch (err) {
            setError(`Error reading ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
            finalize();
          }
        };
        reader.readAsArrayBuffer(file);
      } else {
        finalize();
      }
    });
  }, []);

  const onSheetUrlSubmit = async () => {
    if (!gsheetUrl) return;
    setIsLoading(true);
    setError(null);
    setIsUrlModalOpen(false);

    try {
      const match = gsheetUrl.match(/[-\w]{25,}/);
      if (!match) throw new Error("Invalid Google Sheets URL structure.");
      const sheetId = match[0];

      const commonSheets = ['Individual', 'Team of 2', 'Team of 4'];
      const allProcessed: ProcessedRaceResult[] = [];

      const fetchSheet = (name?: string) => new Promise<void>(async (resolve) => {
        try {
          const exportUrl = name 
            ? `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`
            : `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
          
          const response = await fetch(exportUrl);
          if (!response.ok) return resolve();
          const text = await response.text();
          
          Papa.parse(text, {
            header: true,
            complete: (results) => {
              const eventType = (name as any) || 'Individual';
              const processed = processRawData(results.data as RaceResult[], `gsheet-${sheetId}-${name || 'default'}`, eventType);
              allProcessed.push(...processed);
              resolve();
            },
            error: () => resolve()
          });
        } catch (e) {
          resolve();
        }
      });

      // Try named sheets in parallel
      await Promise.all(commonSheets.map(name => fetchSheet(name)));

      if (allProcessed.length === 0) {
        // Fallback to default
        await fetchSheet();
      }

      const calculateRanks = (data: ProcessedRaceResult[]) => {
        const cp1Sorted = [...data].sort((a,b) => (a.arrivalCP1 || Infinity) - (b.arrivalCP1 || Infinity));
        const cp2Sorted = [...data].sort((a,b) => (a.arrivalCP2 || Infinity) - (b.arrivalCP2 || Infinity));
        const cp3Sorted = [...data].sort((a,b) => (a.arrivalCP3 || Infinity) - (b.arrivalCP3 || Infinity));
        const finSorted = [...data].sort((a,b) => (a.arrivalFinish || Infinity) - (b.arrivalFinish || Infinity));

        return data.map(r => ({
          ...r,
          rankCP1: cp1Sorted.findIndex(x => x.id === r.id) + 1,
          rankCP2: cp2Sorted.findIndex(x => x.id === r.id) + 1,
          rankCP3: cp3Sorted.findIndex(x => x.id === r.id) + 1,
          rankFinish: finSorted.findIndex(x => x.id === r.id) + 1,
        }));
      };

      setData(prev => calculateRanks([...prev, ...allProcessed]));
    } catch (err) {
      setError(`Stream Connection Failed: ${err instanceof Error ? err.message : String(err)}. Ensure sheet is 'Anyone with link can view' and 'Published to Web'.`);
    } finally {
      setIsLoading(false);
      setGsheetUrl('');
    }
  };

  const filteredData = useMemo(() => {
    const filtered = data.filter(r => {
      const matchEvent = eventFilter === 'All' || r.Event === eventFilter;
      const matchGender = genderFilter === 'All' || r.Gender === genderFilter;
      const matchCat = categoryFilter === 'All' || r.Category === categoryFilter;
      return matchEvent && matchGender && matchCat;
    });

    return [...filtered].sort((a, b) => {
      const aValue = a[sortConfig.key];
      const bValue = b[sortConfig.key];

      if (aValue === undefined || aValue === null || aValue === Infinity) return 1;
      if (bValue === undefined || bValue === null || bValue === Infinity) return -1;

      if (aValue < bValue) {
        return sortConfig.direction === 'asc' ? -1 : 1;
      }
      if (aValue > bValue) {
        return sortConfig.direction === 'asc' ? 1 : -1;
      }
      return 0;
    });
  }, [data, eventFilter, genderFilter, categoryFilter, sortConfig]);

  const handleSort = (key: keyof ProcessedRaceResult) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const stats = useMemo((): DashboardStats & { topClub: string } => {
    if (filteredData.length === 0) return { totalParticipants: 0, fastestTime: '00:00:00', slowestTime: '00:00:00', uniqueClubs: 0, topClub: 'N/A' };
    
    const sorted = [...filteredData].sort((a, b) => a.totalTimeSec - b.totalTimeSec);
    const clubCounts: Record<string, number> = {};
    filteredData.forEach(r => { if (r.Club) clubCounts[r.Club] = (clubCounts[r.Club] || 0) + 1; });
    const topClub = Object.entries(clubCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';
    const uniqueClubs = new Set(filteredData.map(r => r.Club).filter(Boolean)).size;

    return {
      totalParticipants: filteredData.length,
      fastestTime: sorted[0].Time,
      slowestTime: sorted[sorted.length - 1].Time,
      uniqueClubs,
      topClub
    };
  }, [filteredData]);

  const clubData = useMemo(() => {
    const counts: Record<string, number> = {};
    filteredData.forEach(r => {
      if (r.Club) counts[r.Club] = (counts[r.Club] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10); // Top 10 clubs
  }, [filteredData]);

  const trafficData = useMemo(() => {
    const bins: Record<string, { time: string, timeSec: number, CP1: number, CP2: number, CP3: number, Finish: number }> = {};
    const binSize = 300; // 5 mins

    filteredData.forEach(r => {
      const cps = [
        { key: 'CP1' as const, val: r.arrivalCP1 },
        { key: 'CP2' as const, val: r.arrivalCP2 },
        { key: 'CP3' as const, val: r.arrivalCP3 },
        { key: 'Finish' as const, val: r.arrivalFinish }
      ];

      cps.forEach(cp => {
        if (!cp.val) return;
        const binSec = Math.floor(cp.val / binSize) * binSize;
        const binKey = binSec.toString();
        if (!bins[binKey]) {
          bins[binKey] = { 
            time: formatSecondsToHHMM(binSec), 
            timeSec: binSec,
            CP1: 0, CP2: 0, CP3: 0, Finish: 0 
          };
        }
        bins[binKey][cp.key]++;
      });
    });

    return Object.values(bins).sort((a, b) => a.timeSec - b.timeSec);
  }, [filteredData]);

  const demographicsData = useMemo(() => {
    const genderCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    
    filteredData.forEach(r => {
      genderCounts[r.Gender] = (genderCounts[r.Gender] || 0) + 1;
      categoryCounts[r.Category] = (categoryCounts[r.Category] || 0) + 1;
    });

    return {
      gender: Object.entries(genderCounts).map(([name, value]) => ({ name, value })),
      category: Object.entries(categoryCounts).map(([name, value]) => ({ name, value }))
    };
  }, [filteredData]);

  const performanceTrackingData = useMemo(() => {
    if (filteredData.length === 0) return [];
    // Take top 5 finishers
    const top5 = [...filteredData].sort((a,b) => a.totalTimeSec - b.totalTimeSec).slice(0, 5);
    
    return [
      { name: 'START', ...top5.reduce((acc, r, i) => ({ ...acc, [`r${i}`]: 0 }), {}) },
      { name: 'CP1', ...top5.reduce((acc, r, i) => ({ ...acc, [`r${i}`]: r.rankCP1 }), {}) },
      { name: 'CP2', ...top5.reduce((acc, r, i) => ({ ...acc, [`r${i}`]: r.rankCP2 }), {}) },
      { name: 'CP3', ...top5.reduce((acc, r, i) => ({ ...acc, [`r${i}`]: r.rankCP3 }), {}) },
      { name: 'FINISH', ...top5.reduce((acc, r, i) => ({ ...acc, [`r${i}`]: r.rankFinish }), {}) },
    ].map(point => ({ ...point, topNames: top5.map(r => r.Name) }));
  }, [filteredData]);

  const scatterData = useMemo(() => {
    return filteredData.map(r => ({
      x: r.arrivalCP1 / 60, // minutes
      y: r.totalTimeSec / 60, // minutes
      name: r.Name
    }));
  }, [filteredData]);

  const leaderboardData = useMemo(() => {
    if (data.length === 0) return null;

    const events = ['Individual', 'Team of 2', 'Team of 4'];
    const genders = ['Male', 'Female', 'Mixed'];
    const categories = [...new Set(data.map(r => r.Category))].filter(Boolean);

    const eventWinners = events.map(event => {
      const runners = data.filter(r => r.Event === event)
        .sort((a, b) => a.totalTimeSec - b.totalTimeSec)
        .slice(0, 3);
      return { event, runners };
    });

    const categoryBreakdown = events.map(event => {
      const eventData = data.filter(r => r.Event === event);
      
      const genderWinners = genders.map(gender => ({
        gender,
        runners: eventData.filter(r => r.Gender === gender)
          .sort((a, b) => a.totalTimeSec - b.totalTimeSec)
          .slice(0, 3)
      })).filter(g => g.runners.length > 0);

      const catWinners = categories.map(cat => ({
        category: cat,
        runners: eventData.filter(r => r.Category === cat)
          .sort((a, b) => a.totalTimeSec - b.totalTimeSec)
          .slice(0, 3)
      })).filter(c => c.runners.length > 0);

      return { event, genderWinners, catWinners };
    });

    return { eventWinners, categoryBreakdown };
  }, [data]);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-950 font-sans">
      {/* Top Navigation Bar */}
      <header className="h-14 border-b border-zinc-800 flex items-center justify-between px-4 bg-zinc-900/50 flex-shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-brand-blue rounded flex items-center justify-center text-white font-bold text-xs italic">FU</div>
            <span className="text-zinc-100 font-semibold tracking-tight text-sm uppercase">FORTH_ULTRA_ANALYTICS_V2</span>
          </div>
          <nav className="flex gap-4 text-[10px] font-bold uppercase tracking-widest">
            <button 
              onClick={() => setActiveTab('TRAFFIC')}
              className={cn("pb-4 mt-4 border-b-2 transition-all", activeTab !== 'LEADERBOARD' && data.length > 0 ? "text-brand-blue border-brand-blue" : "text-zinc-700 border-transparent")}
            >
              Dashboard
            </button>
            <button 
              onClick={() => setActiveTab('LEADERBOARD')}
              className={cn("pb-4 mt-4 border-b-2 transition-all", activeTab === 'LEADERBOARD' ? "text-brand-blue border-brand-blue" : "text-zinc-700 border-transparent")}
            >
              Leaderboard
            </button>
            <button onClick={() => setData([])} className="text-zinc-500 hover:text-red-400 pb-4 mt-4 transition-colors">Wipe_System</button>
          </nav>
        </div>
        
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2 bg-zinc-800/50 px-3 py-1.5 rounded-full border border-zinc-700">
            <span className={cn("w-2 h-2 rounded-full", data.length > 0 ? "bg-emerald-500" : "bg-amber-500")}></span>
            <span className="text-zinc-300 font-mono text-[10px] uppercase">
              {data.length > 0 ? 'Engine: Active' : 'Waiting for Data'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setIsUrlModalOpen(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800/50 hover:bg-zinc-800 text-zinc-400 rounded text-[10px] font-bold uppercase transition-colors border border-zinc-800"
            >
              <Activity className="w-3 h-3" />
              <span>Connect G-Sheet</span>
            </button>
            <label className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[10px] font-bold uppercase cursor-pointer transition-colors border border-zinc-700">
              <Upload className="w-3 h-3" />
              <span>Ingest Payload</span>
              <input type="file" multiple accept=".csv,.xlsx,.xls" className="hidden" onChange={onFileUpload} />
            </label>
          </div>
        </div>
      </header>

      {/* URL Modal */}
      <AnimatePresence>
        {isUrlModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-zinc-950 border border-zinc-800 p-6 rounded-lg w-full max-w-md shadow-2xl"
            >
              <h3 className="text-zinc-100 font-bold text-sm uppercase tracking-widest mb-4">Ingest from Remote Source</h3>
              <p className="text-zinc-500 text-xs mb-4">Provide a Google Sheets URL. Ensure the sheet is <span className="text-emerald-500">Published to the Web</span> for cross-origin access.</p>
              <input 
                value={gsheetUrl}
                onChange={e => setGsheetUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/..."
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-zinc-100 text-xs focus:border-brand-blue outline-none mb-6 font-mono"
              />
              <div className="flex justify-end gap-3">
                <button onClick={() => setIsUrlModalOpen(false)} className="px-4 py-2 text-zinc-500 text-[10px] font-bold uppercase">Cancel</button>
                <button onClick={onSheetUrlSubmit} className="px-4 py-2 bg-brand-blue text-white rounded text-[10px] font-bold uppercase transition-colors hover:bg-blue-600">Sync_Stream</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Athlete Details Modal */}
      <AnimatePresence>
        {selectedAthlete && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-zinc-950 border border-zinc-800 rounded-lg w-full max-w-2xl shadow-2xl relative overflow-hidden"
            >
              <div ref={athleteModalRef} className="p-6 bg-zinc-950 relative">
                {/* Branding strictly for PNG export (and visibly nice too) */}
                <div className="absolute top-6 right-12 text-right pointer-events-none opacity-30">
                  <div className="text-2xl font-black italic tracking-tighter text-zinc-100">FORTH_ULTRA</div>
                  <div className="text-[8px] font-mono text-zinc-400 tracking-widest mt-[-4px]">2026_RESULTS</div>
                </div>

                <button 
                  onClick={() => setSelectedAthlete(null)}
                  className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-100 transition-colors z-10"
                  data-html2canvas-ignore="true"
                >
                  <X className="w-5 h-5" />
                </button>
                
                <div className="flex items-start gap-6 mb-8">
                <div className="w-16 h-16 bg-zinc-900 border border-zinc-800 rounded-lg flex items-center justify-center">
                  <span className="text-2xl font-bold text-zinc-700 italic">{selectedAthlete.Name.charAt(0)}</span>
                </div>
                <div>
                  <h3 className="text-xl font-bold text-zinc-100 uppercase tracking-tight mb-1">{selectedAthlete.Name}</h3>
                  <div className="flex gap-2 items-center">
                    <span className="bg-zinc-900 text-zinc-500 text-[9px] font-mono px-2 py-0.5 rounded border border-zinc-800 uppercase">BIB_{selectedAthlete['Race No']}</span>
                    <span className="bg-brand-blue/10 text-brand-blue text-[9px] font-mono px-2 py-0.5 rounded border border-brand-blue/20 uppercase">{selectedAthlete.Event}</span>
                    <span className="bg-zinc-900 text-zinc-500 text-[9px] font-mono px-2 py-0.5 rounded border border-zinc-800 uppercase">{selectedAthlete.Category}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-8">
                <div className="space-y-4">
                  <div className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest border-b border-zinc-900 pb-1">Segment_Metrics</div>
                  <div className="space-y-3">
                    {[
                      { label: 'CP1', time: selectedAthlete['Culross (CP1)'], rank: selectedAthlete.rankCP1 },
                      { label: 'CP2', time: selectedAthlete['Ferrymuir Gate (CP2)'], rank: selectedAthlete.rankCP2 },
                      { label: 'CP3', time: selectedAthlete['Boness (CP3)'], rank: selectedAthlete.rankCP3 },
                      { label: 'FINISH', time: selectedAthlete.Time, rank: selectedAthlete.rankFinish },
                    ].map(split => (
                      <div key={split.label} className="flex justify-between items-end">
                        <div>
                          <div className="text-[8px] text-zinc-500 font-mono">T.{split.label}</div>
                          <div className="text-sm font-mono text-zinc-300">{split.time}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[8px] text-zinc-500 font-mono">RANK</div>
                          <div className="text-sm font-mono text-emerald-500">#{split.rank}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-zinc-900/40 rounded-lg p-4 border border-zinc-900">
                  <div className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest mb-4">Heuristic_Affiliation</div>
                  <div className="space-y-4">
                    <div>
                      <div className="text-[8px] text-zinc-500 font-mono uppercase mb-1">Assigned_Node</div>
                      <div className="text-sm text-zinc-300 font-medium">{selectedAthlete.Club || 'INDEPENDENT'}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 pt-4 border-t border-zinc-800">
                       <div>
                        <div className="text-[8px] text-zinc-500 font-mono uppercase mb-1">Gen_Rank</div>
                        <div className="text-sm text-zinc-100 font-mono">#{selectedAthlete['Gen Pos']}</div>
                      </div>
                      <div>
                        <div className="text-[8px] text-zinc-500 font-mono uppercase mb-1">Cat_Rank</div>
                        <div className="text-sm text-zinc-100 font-mono">#{selectedAthlete['Cat Pos']}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              </div>
              
              <div className="p-6 pt-4 bg-zinc-950 border-t border-zinc-900 flex justify-end gap-3" data-html2canvas-ignore="true">
                 <button 
                  onClick={handleDownloadPng}
                  className="px-6 py-2 bg-brand-blue/10 text-brand-blue border border-brand-blue/20 rounded font-bold text-[10px] uppercase cursor-pointer hover:bg-brand-blue/20 transition-colors flex items-center gap-2"
                 >
                  <Download className="w-3 h-3" />
                  Download_PNG
                 </button>
                 <button 
                  onClick={() => setSelectedAthlete(null)}
                  className="px-6 py-2 bg-zinc-100 text-zinc-900 rounded font-bold text-[10px] uppercase cursor-pointer hover:bg-white transition-colors"
                 >
                  Finalize_Audit
                 </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="flex-1 flex overflow-hidden">
        {/* Main Workspace */}
        <main className="flex-1 overflow-y-auto p-4 space-y-4">
          <AnimatePresence mode="wait">
            {data.length === 0 ? (
              <motion.div 
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center justify-center h-full text-center"
              >
                <div className="p-8 border-2 border-dashed border-zinc-800 rounded-xl max-w-lg bg-zinc-900/20">
                  <Upload className="w-12 h-12 text-zinc-700 mx-auto mb-4" />
                  <h2 className="text-lg font-bold text-zinc-200 mb-2 uppercase tracking-tight">System Ready for Data Injection</h2>
                  <p className="text-sm text-zinc-500 leading-relaxed mb-6">
                    Awaiting CSV, Spreadsheet (.xlsx), or Google Sheets stream for race performance analysis. <br/>
                    Unified data ingestion engine v2.4 initialized.
                  </p>
                  <div className="flex gap-3">
                    <label className="inline-flex items-center gap-2 px-6 py-2.5 bg-zinc-100 text-zinc-900 rounded font-bold text-xs uppercase cursor-pointer hover:bg-white transition-colors">
                      <Upload className="w-3.5 h-3.5" />
                      <span>Select_Files</span>
                      <input type="file" multiple accept=".csv,.xlsx,.xls" className="hidden" onChange={onFileUpload} />
                    </label>
                    <button 
                      onClick={() => setIsUrlModalOpen(true)}
                      className="inline-flex items-center gap-2 px-6 py-2.5 bg-zinc-900 border border-zinc-800 text-zinc-400 rounded font-bold text-xs uppercase hover:bg-zinc-800 transition-colors"
                    >
                      <Activity className="w-3.5 h-3.5" />
                      <span>Remote_Sync</span>
                    </button>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div 
                key="dashboard"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="space-y-4 pb-8"
              >
                {activeTab === 'LEADERBOARD' ? (
                  <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <div className="flex items-center justify-between border-b border-zinc-900 pb-4">
                       <div className="flex items-center gap-3">
                          <Trophy className="w-6 h-6 text-brand-amber" />
                          <h2 className="text-2xl font-black text-zinc-100 italic tracking-tighter uppercase">EVENT_LEADERBOARDS_V2</h2>
                       </div>
                       <div className="text-[10px] font-mono text-zinc-500">SORT_PRIORITY: T.COMPLETE (ASC)</div>
                    </div>

                    <div className="grid grid-cols-3 gap-6">
                      {leaderboardData?.eventWinners.map(ev => (
                        <div key={ev.event} className="panel bg-zinc-900/40 relative overflow-hidden group">
                           <div className="absolute -right-4 -top-4 opacity-5 group-hover:opacity-10 transition-opacity">
                              <Trophy className="w-24 h-24 text-white" />
                           </div>
                           <div className="panel-header border-b border-white/5">
                              <span className="text-[10px] font-bold text-brand-blue uppercase tracking-[0.2em]">{ev.event}</span>
                           </div>
                           <div className="p-4 space-y-3">
                              {ev.runners.map((r, i) => (
                                <div key={r.id} className="flex items-center justify-between group/runner cursor-pointer" onClick={() => setSelectedAthlete(r)}>
                                   <div className="flex items-center gap-3">
                                      <div className={cn(
                                        "w-6 h-6 rounded flex items-center justify-center font-bold text-[10px] italic",
                                        i === 0 ? "bg-brand-amber/20 text-brand-amber border border-brand-amber/30 shadow-[0_0_10px_rgba(245,158,11,0.2)]" :
                                        i === 1 ? "bg-zinc-400/20 text-zinc-400 border border-zinc-400/30" :
                                        "bg-orange-900/20 text-orange-400 border border-orange-900/30"
                                      )}>
                                        {i + 1}
                                      </div>
                                      <div>
                                         <div className="text-xs font-bold text-zinc-200 group-hover/runner:text-brand-blue transition-colors line-clamp-1">{r.Name}</div>
                                         <div className="text-[8px] text-zinc-500 font-mono uppercase tracking-tighter">{r.Club || 'Independent'}</div>
                                      </div>
                                   </div>
                                   <div className="text-[11px] font-mono font-bold text-zinc-100">{r.Time}</div>
                                </div>
                              ))}
                              {ev.runners.length === 0 && (
                                <div className="text-[10px] text-zinc-500 italic py-4 text-center">No data stream in for this event</div>
                              )}
                           </div>
                        </div>
                      ))}
                    </div>

                    <div className="space-y-6">
                       <div className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest border-l-2 border-brand-blue pl-3">CATEGORY_BREAKDOWN_MATRIX</div>
                       <div className="grid grid-cols-1 gap-8">
                          {leaderboardData?.categoryBreakdown.map(ev => (
                            <div key={ev.event} className="space-y-4">
                               <div className="bg-zinc-900/80 px-4 py-2 border border-zinc-800 rounded flex items-center justify-between">
                                  <span className="text-[11px] font-black text-zinc-100 italic uppercase">{ev.event} / SUBCATEGORIES</span>
                                  <div className="h-px flex-1 mx-4 bg-zinc-800"></div>
                               </div>
                               
                               <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                                  {/* Gender Winners */}
                                  {ev.genderWinners.map(gw => (
                                    <div key={gw.gender} className="bg-zinc-900/30 border border-zinc-900 p-3 rounded hover:border-zinc-800 transition-colors">
                                       <div className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest mb-3 border-b border-zinc-800 pb-1 flex justify-between">
                                          <span>{gw.gender}</span>
                                          <Users className="w-2.5 h-2.5 text-zinc-700" />
                                       </div>
                                       <div className="space-y-2">
                                          {gw.runners.map((r, i) => (
                                            <div key={r.id} className="flex justify-between items-center group/mini cursor-pointer" onClick={() => setSelectedAthlete(r)}>
                                               <span className="text-[11px] text-zinc-400 group-hover/mini:text-zinc-200 transition-colors line-clamp-1">
                                                  <span className="text-zinc-600 mr-2 font-mono">{i+1}.</span>
                                                  {r.Name}
                                               </span>
                                               <span className="text-[10px] font-mono text-zinc-500 ml-2">{r.Time}</span>
                                            </div>
                                          ))}
                                       </div>
                                    </div>
                                  ))}
                                  {/* Category Winners */}
                                  {ev.catWinners.map(cw => (
                                    <div key={cw.category} className="bg-zinc-900/30 border border-zinc-900 p-3 rounded hover:border-zinc-800 transition-colors">
                                       <div className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest mb-3 border-b border-zinc-800 pb-1 flex justify-between">
                                          <span>{cw.category}</span>
                                          <TrendingUp className="w-2.5 h-2.5 text-zinc-700" />
                                       </div>
                                       <div className="space-y-2">
                                          {cw.runners.map((r, i) => (
                                            <div key={r.id} className="flex justify-between items-center group/mini cursor-pointer" onClick={() => setSelectedAthlete(r)}>
                                               <span className="text-[11px] text-zinc-400 group-hover/mini:text-zinc-200 transition-colors line-clamp-1">
                                                  <span className="text-zinc-600 mr-2 font-mono">{i+1}.</span>
                                                  {r.Name}
                                               </span>
                                               <span className="text-[10px] font-mono text-zinc-500 ml-2">{r.Time}</span>
                                            </div>
                                          ))}
                                       </div>
                                    </div>
                                  ))}
                               </div>
                            </div>
                          ))}
                       </div>
                    </div>
                  </div>
                ) : (
                  <>
                {/* Cluster Metrics */}
                <div className="grid grid-cols-4 gap-4">
                  <StatCard title="Total_Entries" value={stats.totalParticipants} icon={Users} color="bg-brand-blue" subtext={`${stats.uniqueClubs} unique affiliations`} />
                  <StatCard title="Peak_Performance" value={stats.fastestTime} icon={Trophy} color="bg-brand-emerald" subtext="Fastest recorded split" />
                  <StatCard title="Terminal_Node" value={stats.slowestTime} icon={Clock} color="bg-brand-amber" subtext="Slowest time at Finish" />
                  <StatCard title="Dominant_Affiliation" value={stats.topClub.slice(0, 15) + (stats.topClub.length > 15 ? '...' : '')} icon={MapPin} color="bg-zinc-500" subtext="Most frequent entry" />
                </div>

                {/* Filters Row */}
                <div className="flex bg-zinc-900/50 border border-zinc-800 p-2 rounded gap-4 items-center">
                  <div className="flex items-center gap-2 px-3 border-r border-zinc-800">
                    <Filter className="w-3 h-3 text-zinc-600" />
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Filters</span>
                  </div>
                  
                  <div className="flex items-center gap-4 text-[10px]">
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-600 font-mono">EVENT:</span>
                      <select value={eventFilter} onChange={e => setEventFilter(e.target.value)} className="bg-zinc-800/50 border border-zinc-700 rounded px-2 py-0.5 text-zinc-300 outline-none hover:border-zinc-500 font-mono">
                        <option value="All">ALL_STREAMS</option>
                        <option value="Individual">INDIV</option>
                        <option value="Team of 2">TEAM_02</option>
                        <option value="Team of 4">TEAM_04</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                       <span className="text-zinc-600 font-mono">GENDER:</span>
                       <select value={genderFilter} onChange={e => setGenderFilter(e.target.value)} className="bg-zinc-800/50 border border-zinc-700 rounded px-2 py-0.5 text-zinc-300 outline-none hover:border-zinc-500 font-mono">
                        <option value="All">ALL_TYPES</option>
                        <option value="Male">MALE</option>
                        <option value="Female">FEMALE</option>
                        <option value="Mixed">MIXED</option>
                       </select>
                    </div>
                    <div className="flex items-center gap-2">
                       <span className="text-zinc-600 font-mono">CAT:</span>
                       <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} className="bg-zinc-800/50 border border-zinc-700 rounded px-2 py-0.5 text-zinc-300 outline-none hover:border-zinc-500 font-mono max-w-[120px]">
                        <option value="All">ALL_CATS</option>
                        {[...new Set(data.map(r => r.Category))].filter(Boolean).map(cat => (
                          <option key={cat} value={cat}>{cat}</option>
                        ))}
                       </select>
                    </div>
                  </div>
                  
                  <button onClick={() => { setEventFilter('All'); setGenderFilter('All'); setCategoryFilter('All'); }} className="ml-auto text-[10px] font-bold text-zinc-600 hover:text-zinc-300 uppercase tracking-tighter transition-colors">
                    Clear_States
                  </button>
                </div>

                <div className="grid grid-cols-12 gap-4">
                  {/* Left Column: Visualization Lab */}
                  <div className="col-span-8 flex flex-col gap-4">
                    {/* Tab Navigation */}
                    <div className="flex bg-zinc-900/80 border border-zinc-800 p-1 rounded gap-1 self-start">
                      <button 
                        onClick={() => setActiveTab('TRAFFIC')}
                        className={cn(
                          "px-4 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-2",
                          activeTab === 'TRAFFIC' ? "bg-zinc-800 text-zinc-100 shadow-sm" : "text-zinc-600 hover:text-zinc-400"
                        )}
                      >
                        <BarChart2 className="w-3 h-3" />
                        Traffic_Node
                      </button>
                      <button 
                        onClick={() => setActiveTab('PERFORMANCE')}
                        className={cn(
                          "px-4 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-2",
                          activeTab === 'PERFORMANCE' ? "bg-zinc-800 text-zinc-100 shadow-sm" : "text-zinc-600 hover:text-zinc-400"
                        )}
                      >
                        <TrendingUp className="w-3 h-3" />
                        Performance_Graph
                      </button>
                      <button 
                        onClick={() => setActiveTab('DEMOGRAPHICS')}
                        className={cn(
                          "px-4 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-2",
                          activeTab === 'DEMOGRAPHICS' ? "bg-zinc-800 text-zinc-100 shadow-sm" : "text-zinc-600 hover:text-zinc-400"
                        )}
                      >
                        <PieChartIcon className="w-3 h-3" />
                        Demographics
                      </button>
                      <button 
                        onClick={() => setActiveTab('ROUTE')}
                        className={cn(
                          "px-4 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-2",
                          activeTab === 'ROUTE' ? "bg-zinc-800 text-zinc-100 shadow-sm" : "text-zinc-600 hover:text-zinc-400"
                        )}
                      >
                        <MapPin className="w-3 h-3" />
                        Route_Map
                      </button>
                    </div>

                    <AnimatePresence mode="wait">
                      {activeTab === 'TRAFFIC' && (
                        <motion.div 
                          key="traffic"
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 20 }}
                          className="panel flex flex-col h-[450px]"
                        >
                          <div className="panel-header flex justify-between items-center pr-4">
                            <div className="flex items-center gap-3">
                              <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">TRAFFIC_DENSITY_ANALYSIS</span>
                              {activeSegments.length < 4 && (
                                <button 
                                  onClick={() => setActiveSegments(['CP1', 'CP2', 'CP3', 'FINISH'])}
                                  className="bg-brand-blue/10 text-brand-blue text-[8px] font-bold px-2 py-0.5 rounded border border-brand-blue/20 hover:bg-brand-blue/20 transition-all uppercase cursor-pointer"
                                >
                                  Reset_Filters
                                </button>
                              )}
                            </div>
                            <Zap className="w-3.5 h-3.5 text-brand-amber animate-pulse" />
                          </div>
                          <div className="flex-1 p-4 min-h-0 min-w-0">
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={trafficData}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#27272a" />
                                <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#71717a', fontFamily: 'JetBrains Mono' }} />
                                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#71717a', fontFamily: 'JetBrains Mono' }} />
                                <Tooltip 
                                  contentStyle={{ backgroundColor: '#18181b', borderRadius: '4px', border: '1px solid #27272a', fontSize: '11px', color: '#d4d4d8', fontFamily: 'JetBrains Mono' }}
                                  cursor={{ fill: 'rgba(39, 39, 42, 0.5)' }}
                                />
                                <Legend 
                                  verticalAlign="top" 
                                  height={36} 
                                  iconType="rect" 
                                  onClick={handleLegendClick}
                                  formatter={(value: string) => (
                                    <span className={cn(
                                      "transition-all duration-300",
                                      activeSegments.includes(value) ? "text-zinc-100 font-bold" : "text-zinc-600 font-normal"
                                    )}>
                                      {value}
                                    </span>
                                  )}
                                  wrapperStyle={{ fontSize: '10px', fontFamily: 'JetBrains Mono', textTransform: 'uppercase', cursor: 'pointer' }} 
                                />
                                <Bar name="CP1" dataKey="CP1" fill={PANTONE_COLORS[0]} hide={!activeSegments.includes('CP1')} radius={[2, 2, 0, 0]} stackId="a" />
                                <Bar name="CP2" dataKey="CP2" fill={PANTONE_COLORS[1]} hide={!activeSegments.includes('CP2')} radius={[2, 2, 0, 0]} stackId="a" />
                                <Bar name="CP3" dataKey="CP3" fill={PANTONE_COLORS[2]} hide={!activeSegments.includes('CP3')} radius={[2, 2, 0, 0]} stackId="a" />
                                <Bar name="FINISH" dataKey="Finish" fill={PANTONE_COLORS[3]} hide={!activeSegments.includes('FINISH')} radius={[2, 2, 0, 0]} stackId="a" />
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        </motion.div>
                      )}

                      {activeTab === 'PERFORMANCE' && (
                        <motion.div 
                          key="perf"
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 20 }}
                          className="space-y-4"
                        >
                          <div className="panel h-[220px]">
                            <div className="panel-header">
                              <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">RANK_VOLATILITY_TOP_5</span>
                              <TrendingUp className="w-3.5 h-3.5 text-zinc-600" />
                            </div>
                            <div className="p-4 h-[180px] min-h-0 min-w-0">
                              <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={performanceTrackingData}>
                                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#71717a' }} />
                                  <YAxis reversed axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#71717a' }} />
                                  <Tooltip 
                                    contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', fontSize: '10px' }}
                                    formatter={(value, name, props) => {
                                      const idx = parseInt(name.toString().replace('r', ''));
                                      return [value, props.payload.topNames?.[idx] || name];
                                    }}
                                  />
                                  {[0,1,2,3,4].map(idx => (
                                    <Line key={idx} type="monotone" dataKey={`r${idx}`} stroke={PANTONE_COLORS[idx % PANTONE_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} />
                                  ))}
                                </LineChart>
                              </ResponsiveContainer>
                            </div>
                          </div>
                          
                          <div className="panel h-[214px]">
                            <div className="panel-header">
                              <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">PACING_CORRELATION (CP1 vs FINISH)</span>
                              <span className="text-[9px] font-mono text-zinc-500 italic">X: CP1_MIN | Y: FINISH_MIN</span>
                            </div>
                            <div className="p-4 h-[174px] min-h-0 min-w-0">
                               <ResponsiveContainer width="100%" height="100%">
                                <ScatterChart>
                                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                                  <XAxis type="number" dataKey="x" name="CP1" unit="m" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#71717a' }} />
                                  <YAxis type="number" dataKey="y" name="Finish" unit="m" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#71717a' }} />
                                  <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', fontSize: '10px' }} />
                                  <Scatter name="Runners" data={scatterData} fill={PANTONE_COLORS[0]} />
                                </ScatterChart>
                               </ResponsiveContainer>
                            </div>
                          </div>
                        </motion.div>
                      )}

                      {activeTab === 'DEMOGRAPHICS' && (
                        <motion.div 
                          key="demo"
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 20 }}
                          className="grid grid-cols-2 gap-4 h-[450px]"
                        >
                          <div className="panel">
                             <div className="panel-header">
                               <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">GENDER_DISTRIBUTION</span>
                             </div>
                             <div className="p-4 h-[400px] min-h-0 min-w-0">
                               <ResponsiveContainer width="100%" height="100%">
                                  <PieChart>
                                    <Pie data={demographicsData.gender} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} fill="#8884d8" label={{ fontSize: 9, fill: '#71717a' }}>
                                      {demographicsData.gender.map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={PANTONE_COLORS[index % PANTONE_COLORS.length]} />
                                      ))}
                                    </Pie>
                                    <Tooltip contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', fontSize: '11px' }} />
                                    <Legend wrapperStyle={{ fontSize: '10px', textTransform: 'uppercase' }} />
                                  </PieChart>
                               </ResponsiveContainer>
                             </div>
                          </div>
                          <div className="panel">
                             <div className="panel-header">
                               <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">CATEGORY_SEGMENTATION</span>
                             </div>
                             <div className="p-4 h-[400px] min-h-0 min-w-0">
                               <ResponsiveContainer width="100%" height="100%">
                                  <PieChart>
                                    <Pie data={demographicsData.category} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={5} label={{ fontSize: 9, fill: '#71717a' }}>
                                      {demographicsData.category.map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={PANTONE_COLORS[(index + 3) % PANTONE_COLORS.length]} />
                                      ))}
                                    </Pie>
                                    <Tooltip contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', fontSize: '11px' }} />
                                    <Legend wrapperStyle={{ fontSize: '10px', textTransform: 'uppercase' }} />
                                  </PieChart>
                               </ResponsiveContainer>
                             </div>
                          </div>
                        </motion.div>
                      )}

                      {activeTab === 'ROUTE' && (
                        <motion.div 
                          key="route"
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 20 }}
                          className="panel flex flex-col h-[450px]"
                        >
                          <div className="panel-header">
                            <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">COURSE_RECON_GEOSPATIAL</span>
                            <div className="flex gap-2">
                               <span className="text-[9px] font-mono text-zinc-500 uppercase">Live_Telemetry: Active</span>
                            </div>
                          </div>
                          <div className="flex-1 relative">
                            <MapContainer 
                              center={[56.0022, -3.6125]} 
                              zoom={11} 
                              scrollWheelZoom={false}
                              className="z-0"
                            >
                              <TileLayer
                                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                              />
                              {/* Checkpoints */}
                              <Marker position={[56.0555, -3.6291]}>
                                <Popup><div className="text-[10px] uppercase font-bold">Culross (CP1)</div></Popup>
                              </Marker>
                              <Marker position={[55.9863, -3.4014]}>
                                <Popup><div className="text-[10px] uppercase font-bold">Ferrymuir (CP2)</div></Popup>
                              </Marker>
                              <Marker position={[56.0064, -3.6125]}>
                                <Popup><div className="text-[10px] uppercase font-bold">Bo'ness (CP3)</div></Popup>
                              </Marker>
                              <Marker position={[56.0022, -3.7846]}>
                                <Popup><div className="text-[10px] uppercase font-bold">Falkirk Finish</div></Popup>
                              </Marker>
                            </MapContainer>
                            <div className="absolute top-4 right-4 z-[1000] space-y-2 pointer-events-none">
                               <div className="bg-zinc-950/80 border border-zinc-800 p-2 rounded backdrop-blur shadow-xl pointer-events-auto">
                                  <div className="text-[8px] font-bold text-zinc-500 uppercase mb-1">Environmental_Overlay</div>
                                  <div className="flex items-center gap-2">
                                     <div className="w-2 h-2 rounded-full bg-brand-blue animate-pulse"></div>
                                     <span className="text-[9px] text-zinc-300 font-mono tracking-tighter">Density: HIGH_CONCENTRATION</span>
                                  </div>
                               </div>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* Right Column: Schema Affiliation */}
                  <div className="col-span-4 panel flex flex-col h-[509px]">
                    <div className="panel-header">
                      <div className="flex flex-col">
                        <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">SCHEMA_AFFILIATION_DIST</span>
                        <span className="text-[9px] text-zinc-600 font-mono italic">Top 10 Nodes</span>
                      </div>
                      <Users className="w-3.5 h-3.5 text-zinc-600" />
                    </div>
                    <div className="flex-1 p-4 min-h-0 min-w-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={clubData} layout="vertical">
                          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#27272a" />
                          <XAxis type="number" hide />
                          <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#71717a', fontFamily: 'JetBrains Mono' }} width={110} />
                          <Tooltip 
                            contentStyle={{ backgroundColor: '#18181b', borderRadius: '4px', border: '1px solid #27272a', fontSize: '11px', color: '#d4d4d8', fontFamily: 'JetBrains Mono' }}
                          />
                          <Bar dataKey="count" radius={[0, 2, 2, 0]}>
                            {clubData.map((_, index) => (
                              <Cell key={`cell-${index}`} fill={PANTONE_COLORS[index % PANTONE_COLORS.length]} fillOpacity={0.8} />
                            ))}
                            <LabelList dataKey="count" position="right" style={{ fontSize: '9px', fill: '#a1a1aa', fontFamily: 'JetBrains Mono' }} />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="p-3 border-t border-zinc-800 bg-zinc-900/30">
                       <div className="text-[10px] text-zinc-500 uppercase font-bold mb-2">Detailed Inspector</div>
                       <div className="space-y-1">
                          {clubData.slice(0, 3).map((club, idx) => (
                            <div key={club.name} className="flex items-center justify-between text-[10px]">
                              <span className="flex items-center gap-1.5 text-zinc-400">
                                <span className={cn("w-1 h-1 rounded-full", idx === 0 ? "bg-emerald-500" : "bg-zinc-700")}></span>
                                {club.name}
                              </span>
                              <span className="text-zinc-500 font-mono">{club.count}</span>
                            </div>
                          ))}
                       </div>
                    </div>
                  </div>
                </div>

                {/* Terminal Table */}
                <div className="panel flex flex-col overflow-hidden">
                   <div className="panel-header bg-zinc-900/80">
                      <div className="flex items-center gap-4">
                        <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">RECORD_STREAM_VIEWER</span>
                        <span className="text-[10px] font-mono text-zinc-600">OFFSET: 0 | LIMIT: 50 | TOTAL: {filteredData.length}</span>
                      </div>
                      <div className="flex items-center gap-4">
                         <div className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                            <span className="text-[9px] text-zinc-500 font-mono tracking-tighter">DATASTREAM.SYNC</span>
                         </div>
                      </div>
                   </div>
                   <div className="overflow-x-auto">
                    <table className="w-full text-left text-[11px] font-mono whitespace-nowrap">
                      <thead>
                        <tr className="bg-zinc-900/30 border-b border-zinc-800">
                          <th onClick={() => handleSort('Name')} className="px-4 py-2 font-bold text-zinc-500 uppercase cursor-pointer hover:text-zinc-300 transition-colors">
                            <div className="flex items-center gap-1">
                              Athlete
                              {sortConfig.key === 'Name' && (sortConfig.direction === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                            </div>
                          </th>
                          <th onClick={() => handleSort('Event')} className="px-4 py-2 font-bold text-zinc-500 uppercase cursor-pointer hover:text-zinc-300 transition-colors">
                            <div className="flex items-center gap-1">
                              Event
                              {sortConfig.key === 'Event' && (sortConfig.direction === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                            </div>
                          </th>
                          <th onClick={() => handleSort('Club')} className="px-4 py-2 font-bold text-zinc-500 uppercase cursor-pointer hover:text-zinc-300 transition-colors">
                            <div className="flex items-center gap-1">
                              Node_Group
                              {sortConfig.key === 'Club' && (sortConfig.direction === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                            </div>
                          </th>
                          <th onClick={() => handleSort('arrivalCP1')} className="px-4 py-2 font-bold text-zinc-500 uppercase cursor-pointer hover:text-zinc-300 transition-colors">
                            <div className="flex items-center gap-1">
                              T.CP1
                              {sortConfig.key === 'arrivalCP1' && (sortConfig.direction === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                            </div>
                          </th>
                          <th onClick={() => handleSort('arrivalCP2')} className="px-4 py-2 font-bold text-zinc-500 uppercase cursor-pointer hover:text-zinc-300 transition-colors">
                            <div className="flex items-center gap-1">
                              T.CP2
                              {sortConfig.key === 'arrivalCP2' && (sortConfig.direction === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                            </div>
                          </th>
                          <th onClick={() => handleSort('arrivalCP3')} className="px-4 py-2 font-bold text-zinc-500 uppercase cursor-pointer hover:text-zinc-300 transition-colors">
                            <div className="flex items-center gap-1">
                              T.CP3
                              {sortConfig.key === 'arrivalCP3' && (sortConfig.direction === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                            </div>
                          </th>
                          <th onClick={() => handleSort('totalTimeSec')} className="px-4 py-2 font-bold text-zinc-500 uppercase cursor-pointer hover:text-zinc-300 transition-colors text-right">
                            <div className="flex items-center justify-end gap-1">
                              T.COMPLETE
                              {sortConfig.key === 'totalTimeSec' && (sortConfig.direction === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                            </div>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-900">
                        {filteredData.slice(0, 50).map((r) => (
                          <tr key={r.id} className="hover:bg-zinc-900/50 transition-colors group">
                            <td className="px-4 py-2">
                              <button 
                                onClick={() => setSelectedAthlete(r)}
                                className="text-zinc-300 group-hover:text-brand-blue transition-colors text-left font-bold"
                              >
                                {r.Name}
                              </button>
                            </td>
                            <td className="px-4 py-2">
                              <span className={cn(
                                "text-[9px] font-bold px-1.5 py-0.5 rounded border",
                                r.Event === 'Individual' ? "bg-blue-900/20 border-blue-800 text-blue-400" :
                                r.Event === 'Team of 2' ? "bg-emerald-900/20 border-emerald-800 text-emerald-400" : "bg-amber-900/20 border-amber-800 text-amber-400"
                              )}>
                                {r.Event.replace('Team of ', 'T0')}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-zinc-500 italic">{r.Club || 'ORPHANED'}</td>
                            <td className="px-4 py-2 text-zinc-600">{r['Culross (CP1)']}</td>
                            <td className="px-4 py-2 text-zinc-600">{r['Ferrymuir Gate (CP2)']}</td>
                            <td className="px-4 py-2 text-zinc-600">{r['Boness (CP3)']}</td>
                            <td className="px-4 py-2 font-bold text-emerald-500 text-right">{r.Time}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                </>
             )}
            </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Status Bar / Log - Internalized */}
        <footer className="h-40 bg-black border-l border-zinc-800 w-80 p-3 font-mono text-[10px] flex-shrink-0 flex flex-col hidden lg:flex">
            <div className="flex gap-4 border-b border-zinc-900 pb-1 mb-2">
              <button className="text-zinc-400 border-b border-zinc-400">System_Status</button>
              <button className="text-zinc-700">Audit_Log</button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1">
              {logs.map((log, i) => (
                <p key={i}>
                  <span className="text-zinc-600">[{log.time}]</span>{' '}
                  <span className={cn(
                    "italic",
                    log.type === 'INFO' && "text-blue-500",
                    log.type === 'WARN' && "text-amber-500",
                    log.type === 'READY' && "text-emerald-500",
                    log.type === 'ERROR' && "text-red-500 font-bold"
                  )}>
                    {log.type}
                  </span>{' '}
                  {log.msg}
                </p>
              ))}
              <div className="flex items-center gap-2">
                <span className="text-zinc-500">$</span>
                <span className="w-1.5 h-3 bg-zinc-500 animate-pulse inline-block"></span>
              </div>
            </div>
        </footer>
      </div>

      {error && (
        <div className="fixed bottom-4 right-4 bg-red-950/90 border border-red-900 p-3 rounded shadow-2xl flex items-center gap-3 animate-in slide-in-from-bottom font-mono">
          <AlertCircle className="w-4 h-4 text-red-500" />
          <p className="text-[11px] text-red-200">{error}</p>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-200 font-bold ml-2">_EXIT</button>
        </div>
      )}
    </div>
  );
}
