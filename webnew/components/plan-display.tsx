import { motion } from 'framer-motion';
import { CheckCircle, Loader, AlertCircle, XCircle } from 'lucide-react';
import { PlanEntry } from '@/hooks/useChat';

const PlanStateIcon = ({ state }: { state: PlanEntry['state'] }) => {
  switch (state) {
    case 'completed':
      return <CheckCircle className="h-4 w-4 text-green-500" />;
    case 'in_progress':
      return <Loader className="h-4 w-4 animate-spin text-blue-500" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-red-500" />;
    case 'pending':
    default:
      return <div className="h-4 w-4" />;
  }
};

export const PlanDisplay = ({ plan }: { plan: PlanEntry[] }) => {
  if (!plan || plan.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="mb-4 p-3 border rounded-lg bg-gray-50 dark:bg-gray-800"
    >
      <h3 className="text-sm font-semibold mb-2">Execution Plan:</h3>
      <ul className="space-y-2">
        {plan.map((entry) => (
          <li key={entry.id} className="flex items-center text-xs">
            <PlanStateIcon state={entry.state} />
            <span className="ml-2">{entry.title}</span>
          </li>
        ))}
      </ul>
    </motion.div>
  );
};