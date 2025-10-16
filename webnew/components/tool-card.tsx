"use client";

import { CheckCircle, AlertCircle, Loader, Code, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ToolCardState } from '@/hooks/use-chat';

interface ToolCardProps {
  toolCard: ToolCardState;
  onConfirm: (callId: string) => void;
}

const statusIcons = {
  running: <Loader className="animate-spin" />,
  finished: <CheckCircle className="text-green-500" />,
  error: <AlertCircle className="text-red-500" />,
};

export function ToolCard({ toolCard, onConfirm }: ToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const { callId, icon, label, command, status, content, isConfirmed } = toolCard;

  const Icon = statusIcons[status];

  return (
    <Card className="w-full bg-white dark:bg-slate-800">
      <CardHeader className="flex flex-row items-center justify-between p-4">
        <div className="flex items-center space-x-2">
          {Icon}
          <CardTitle className="text-base font-medium">{label || 'Tool Execution'}</CardTitle>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setIsExpanded(!isExpanded)}>
          {isExpanded ? <ChevronDown /> : <ChevronRight />}
        </Button>
      </CardHeader>
      {isExpanded && (
        <CardContent className="p-4">
          {command && (
            <div className="flex items-center space-x-2 p-2 bg-gray-100 dark:bg-slate-700 rounded-md">
              <Code size={16} className="text-gray-600 dark:text-gray-400" />
              <pre className="text-sm text-gray-800 dark:text-gray-200"><code>{command}</code></pre>
            </div>
          )}
          <div className="mt-2 p-2 bg-gray-50 dark:bg-slate-700/50 text-gray-800 dark:text-gray-200 rounded-md">
            <pre className="text-sm whitespace-pre-wrap"><code>{content}</code></pre>
          </div>
          {!isConfirmed && (
            <div className="mt-4 flex justify-end space-x-2">
              <Button variant="outline" size="sm">Cancel</Button>
              <Button size="sm" onClick={() => onConfirm(callId)} className="bg-blue-600 hover:bg-blue-700 text-white dark:bg-blue-700 dark:hover:bg-blue-800">Confirm</Button>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}