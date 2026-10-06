'use client';

import { useState, useEffect } from 'react';
import {
  FlaskConical,
  Activity,
  Brain,
  Search,
  GitMerge,
  BarChart,
  Database,
  ArrowRight,
  CheckCircle2,
  XCircle,
  MessageSquare,
} from 'lucide-react';
import {
  getTestingStatus,
  getAiStatus,
  getMlStatus,
  classify,
  ragSearch,
  debugPipeline,
  evaluateMl,
  getVectorStats,
} from '@/lib/api/ai';
import { listWorkspaces } from '@/lib/api/workspaces';
import { listBots, type Bot } from '@/lib/api/bots';
import { Tabs } from '@/components/ui/tabs';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';

export default function AiLabPage() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loadingBots, setLoadingBots] = useState(true);

  useEffect(() => {
    // Load bots for the selectors
    async function loadAllBots() {
      try {
        const workspaces = await listWorkspaces();
        const allBots: Bot[] = [];
        for (const ws of workspaces) {
          const wsBots = await listBots(ws.id);
          allBots.push(...wsBots);
        }
        setBots(allBots);
      } catch (e) {
        // ignore
      } finally {
        setLoadingBots(false);
      }
    }
    loadAllBots();
  }, []);

  const tabs = [
    { id: 'overview', label: 'Overview', content: <OverviewTab /> },
    { id: 'classifier', label: 'Intent Classifier', content: <ClassifierTab /> },
    { id: 'rag', label: 'RAG Search', content: <RagTab bots={bots} /> },
    { id: 'pipeline', label: 'Pipeline Debug', content: <PipelineTab bots={bots} /> },
    { id: 'ml-eval', label: 'ML Evaluation', content: <MlEvalTab /> },
    { id: 'vector', label: 'Vector DB', content: <VectorTab /> },
  ];

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-accent flex items-center justify-center shadow-sm">
          <FlaskConical className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-foreground tracking-tight">AI Lab</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Test and evaluate the underlying ML and AI models.
          </p>
        </div>
      </div>

      <Card>
        <CardBody className="p-0">
          <Tabs tabs={tabs} defaultTab="overview" />
        </CardBody>
      </Card>
    </div>
  );
}

// --- Tab Components ---

function StatusItem({ label, status }: { label: string; status: string }) {
  const isHealthy = status.toLowerCase() === 'healthy' || status.toLowerCase() === 'ready' || status.toLowerCase() === 'connected' || status.toLowerCase() === 'available';
  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        {isHealthy ? (
          <CheckCircle2 className="h-4 w-4 text-[var(--green-500)]" />
        ) : (
          <XCircle className="h-4 w-4 text-[var(--red-500)]" />
        )}
        <span className={`text-sm font-medium ${isHealthy ? 'text-[var(--green-600)] dark:text-[var(--green-500)]' : 'text-[var(--red-600)] dark:text-[var(--red-500)]'}`}>
          {status}
        </span>
      </div>
    </div>
  );
}

function OverviewTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getTestingStatus(), getMlStatus(), getAiStatus()])
      .then(([sys, ml, ai]) => {
        setData({ sys, ml, ai });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="py-20 flex justify-center"><Spinner /></div>;
  if (!data) return <div className="p-8 text-center text-muted-foreground">Failed to load status.</div>;

  return (
    <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Activity className="h-4 w-4" /> System Health</CardTitle>
        </CardHeader>
        <CardBody>
          <StatusItem label="API Gateway" status={data.sys.api || 'Healthy'} />
          <StatusItem label="ML Intent Model" status={data.sys.ml_model || 'Unknown'} />
          <StatusItem label="Vector Database" status={data.sys.vector_store || 'Unknown'} />
          <StatusItem label="Embedding Service" status={data.sys.embedding_service || 'Unknown'} />
          <StatusItem label="LLM Provider" status={data.sys.llm || 'Unknown'} />
        </CardBody>
      </Card>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Brain className="h-4 w-4" /> ML Model Details</CardTitle>
          </CardHeader>
          <CardBody>
             <p className="text-sm mb-1"><span className="text-muted-foreground">Type:</span> {data.ml.model_type}</p>
             <p className="text-sm mb-3"><span className="text-muted-foreground">Classes:</span> {data.ml.classes?.length || 0} supported intents</p>
             <div className="flex flex-wrap gap-1.5">
               {data.ml.classes?.slice(0, 5).map((c: string) => (
                 <Badge key={c} variant="default">{c}</Badge>
               ))}
               {data.ml.classes?.length > 5 && <Badge variant="default">+{data.ml.classes.length - 5} more</Badge>}
             </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function ClassifierTab() {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const { toast } = useToast();

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setLoading(true);
    try {
      const res = await classify(text);
      setResult(res);
    } catch (err: any) {
      toast(err.message || 'Classification failed', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6">
      <div className="max-w-2xl mb-8">
        <h2 className="text-sm font-semibold mb-2">Test Intent Classification</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Enter a customer message to see how the ML model classifies it.
        </p>
        <form onSubmit={handleRun} className="flex gap-2">
          <Input 
            className="flex-1" 
            placeholder="e.g. I need to reset my password" 
            value={text} 
            onChange={(e) => setText(e.target.value)} 
          />
          <Button type="submit" loading={loading}>Classify</Button>
        </form>
      </div>

      {result && (
        <Card className="max-w-2xl bg-muted/30">
          <CardBody>
             <div className="mb-4">
               <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Top Prediction</p>
               <div className="flex items-center gap-3">
                 <Badge variant="success" className="text-sm px-3 py-1">{result.predicted_intent}</Badge>
                 <span className="text-sm font-mono text-muted-foreground">{(result.confidence * 100).toFixed(1)}% confidence</span>
               </div>
             </div>
             
             {result.top_predictions && result.top_predictions.length > 1 && (
               <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-2">Other Probabilities</p>
                  <div className="space-y-2">
                    {result.top_predictions.slice(1, 4).map((p: any) => (
                      <div key={p.intent} className="flex items-center justify-between text-sm">
                        <span>{p.intent}</span>
                        <span className="font-mono text-muted-foreground">{(p.confidence * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
               </div>
             )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function RagTab({ bots }: { bots: Bot[] }) {
  const [botId, setBotId] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const { toast } = useToast();

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    if (!botId || !query.trim()) return;
    setLoading(true);
    try {
      const res = await ragSearch({ bot_id: botId, query, top_k: 3 });
      setResult(res);
    } catch (err: any) {
      toast(err.message || 'Search failed', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6">
      <div className="max-w-3xl mb-8">
         <h2 className="text-sm font-semibold mb-2">Semantic Knowledge Retrieval</h2>
         <form onSubmit={handleRun} className="space-y-4">
           <div className="flex gap-4">
             <select 
               className="h-9 rounded-lg border border-border bg-background px-3 text-sm focus:border-accent focus:outline-none w-64"
               value={botId}
               onChange={(e) => setBotId(e.target.value)}
               required
             >
               <option value="">Select Bot...</option>
               {bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
             </select>
             <Input 
               className="flex-1" 
               placeholder="Search query..." 
               value={query} 
               onChange={(e) => setQuery(e.target.value)} 
               required
             />
             <Button type="submit" loading={loading}>Search</Button>
           </div>
         </form>
      </div>

      {result && (
        <div className="space-y-4 max-w-4xl">
          <p className="text-sm font-medium">Found {result.results.length} chunks</p>
          {result.results.map((r: any, i: number) => (
            <Card key={i}>
              <CardBody>
                <div className="flex justify-between items-start mb-2">
                  <Badge variant="info">Score: {r.score.toFixed(4)}</Badge>
                  {r.metadata?.category && <span className="text-xs text-muted-foreground">{r.metadata.category}</span>}
                </div>
                <p className="text-sm whitespace-pre-wrap">{r.content}</p>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function PipelineTab({ bots }: { bots: Bot[] }) {
  const [botId, setBotId] = useState('');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const { toast } = useToast();

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    if (!botId || !question.trim()) return;
    setLoading(true);
    try {
      const res = await debugPipeline({ bot_id: botId, message: question });
      setResult(res);
    } catch (err: any) {
      toast(err.message || 'Pipeline debug failed', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6">
      <div className="max-w-3xl mb-8">
         <form onSubmit={handleRun} className="space-y-4">
           <div className="flex gap-4">
             <select 
               className="h-9 rounded-lg border border-border bg-background px-3 text-sm focus:border-accent focus:outline-none w-64"
               value={botId}
               onChange={(e) => setBotId(e.target.value)}
               required
             >
               <option value="">Select Bot...</option>
               {bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
             </select>
             <Input 
               className="flex-1" 
               placeholder="User question..." 
               value={question} 
               onChange={(e) => setQuestion(e.target.value)} 
               required
             />
             <Button type="submit" loading={loading}>Run Pipeline</Button>
           </div>
         </form>
      </div>

      {result && (
        <div className="max-w-4xl space-y-2 relative pb-8">
          {/* Vertical Line */}
          <div className="absolute left-[19px] top-4 bottom-8 w-[2px] bg-border z-0" />
          
          <PipelineStep 
            icon={<Brain className="h-4 w-4" />}
            title="1. Intent Classification"
            data={result.classification}
          />
          <PipelineStep 
            icon={<Search className="h-4 w-4" />}
            title="2. Knowledge Retrieval"
            data={result.retrieval_strategy}
          />
          <PipelineStep 
            icon={<GitMerge className="h-4 w-4" />}
            title="3. Confidence Evaluation"
            data={result.retrieval_confidence}
          />
          <PipelineStep 
            icon={<MessageSquare className="h-4 w-4" />}
            title="4. Final Response"
            data={result.final_result}
            isLast
          />
        </div>
      )}
    </div>
  );
}

function PipelineStep({ icon, title, data, isLast }: { icon: any; title: string; data: any; isLast?: boolean }) {
  return (
    <div className="relative z-10 flex gap-4">
      <div className="mt-1 h-10 w-10 shrink-0 rounded-full bg-background border-2 border-border flex items-center justify-center shadow-sm">
        {icon}
      </div>
      <div className="flex-1 pb-6">
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle>{title}</CardTitle>
          </CardHeader>
          <CardBody className="p-4 bg-muted/30">
             <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap overflow-x-auto">
               {JSON.stringify(data, null, 2)}
             </pre>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function MlEvalTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleEval() {
    setLoading(true);
    try {
      const res = await evaluateMl();
      setData(res);
    } catch (err: any) {
      toast(err.message || 'Evaluation failed', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <Button onClick={handleEval} loading={loading}>
          <BarChart className="h-4 w-4 mr-2" />
          Run Full Model Evaluation
        </Button>
      </div>

      {data && (
        <div className="space-y-6 max-w-4xl">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard label="Accuracy" value={data.accuracy} />
            <MetricCard label="Precision" value={data.precision} />
            <MetricCard label="Recall" value={data.recall} />
            <MetricCard label="F1 Score" value={data.f1_score} />
          </div>
          
          <Card>
            <CardHeader>
              <CardTitle>Detailed Classification Report</CardTitle>
            </CardHeader>
            <CardBody>
               <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap overflow-x-auto">
                 {JSON.stringify(data.classification_report, null, 2)}
               </pre>
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardBody className="text-center py-6">
        <p className="text-sm text-muted-foreground mb-1">{label}</p>
        <p className="text-3xl font-bold text-foreground">{(value * 100).toFixed(1)}%</p>
      </CardBody>
    </Card>
  );
}

function VectorTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getVectorStats()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="py-20 flex justify-center"><Spinner /></div>;
  if (!data) return <div className="p-8 text-center text-muted-foreground">Failed to load vector stats.</div>;

  return (
    <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
       <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Database className="h-4 w-4" /> pgvector Health</CardTitle>
          </CardHeader>
          <CardBody>
            <StatusItem label="Status" status={data.status} />
            <div className="flex items-center justify-between py-2 border-b border-border">
              <span className="text-sm text-foreground">Total Chunks</span>
              <span className="text-sm font-mono font-medium">{data.total_chunks}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border">
              <span className="text-sm text-foreground">Bots Indexed</span>
              <span className="text-sm font-mono font-medium">{data.bots_indexed}</span>
            </div>
          </CardBody>
        </Card>
    </div>
  );
}
