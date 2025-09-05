"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useTheme } from "next-themes"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { getSubjectStyle } from "@/lib/utils";
import { SettingsIcon, User, Bell, Palette, Shield, Download, Upload, Trash2, Save } from "lucide-react"

interface SettingsProps {
  uniqueSubjects: string[];
  subjectColors: Record<string, string>;
  onColorChange: (subject: string, color: string) => void;
  onSaveColors: () => Promise<void>;
}

export function Settings({ uniqueSubjects, subjectColors, onColorChange, onSaveColors }: SettingsProps) {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [notifications, setNotifications] = useState(true)
  const [studyReminders, setStudyReminders] = useState(true)
  const [weeklyReports, setWeeklyReports] = useState(true)
  const [weeklyPeriod, setWeeklyPeriod] = useState('this_week');
  const [weekStart, setWeekStart] = useState<'sunday' | 'monday'>('sunday');
  const [appInfo, setAppInfo] = useState<{ version: string | null; lastCommitDate: string | null; git: { branch?: string | null; commit?: string | null } | null } | null>(() => {
    if (typeof window === 'undefined') return null;
    try { const raw = localStorage.getItem('app.info'); return raw ? JSON.parse(raw) : null; } catch { return null; }
  })
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  // Tools / YOLO mode（ローカルキャッシュ優先で即表示。サーバ同期で上書き）
  const [yoloMode, setYoloMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try { const v = localStorage.getItem('tools.yolo'); return v === null ? true : v === 'true'; } catch { return true; }
  });
  const [rulesOpen, setRulesOpen] = useState(false);
  const [allowAlways, setAllowAlways] = useState<string[]>([]);
  const [denyAlways, setDenyAlways] = useState<string[]>([]);
  const SHOW_TEMPLATES = false; // 将来的に使うテンプレート群は非表示

  useEffect(() => {
    // Load server-side settings first; fallback to localStorage
    const load = async () => {
      try {
        const r = await fetch('/api/settings?keys=weeklyPeriod,weekStart,tools.yolo');
        const data = await r.json();
        const s = data?.settings || {};
        const p = (s['weeklyPeriod'] as string) || localStorage.getItem('weeklyPeriod') || 'this_week';
        const w = (s['weekStart'] as 'sunday'|'monday') || (localStorage.getItem('weekStart') as any) || 'sunday';
        if (typeof s['tools.yolo'] === 'boolean') {
          const v = Boolean(s['tools.yolo']);
          setYoloMode(v);
          try { localStorage.setItem('tools.yolo', String(v)); } catch {}
        }
        setWeeklyPeriod(p);
        setWeekStart(w);
        try { localStorage.setItem('weeklyPeriod', p); localStorage.setItem('weekStart', w); } catch {}
        setSettingsLoaded(true);
      } catch {
        const savedPeriod = localStorage.getItem('weeklyPeriod') || 'this_week';
        setWeeklyPeriod(savedPeriod);
        const savedStart = (localStorage.getItem('weekStart') as 'sunday' | 'monday') || 'sunday';
        setWeekStart(savedStart);
        setSettingsLoaded(true);
      }
    };
    load();
  }, []);

  const handleWeeklyPeriodChange = (value: string) => {
    setWeeklyPeriod(value);
    localStorage.setItem('weeklyPeriod', value);
    try { fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'weeklyPeriod', value }) }); } catch {}
    toast.info(`集計期間を「${value === 'this_week' ? '今週' : '過去7日間'}」に変更しました。`);
  };
  const handleWeekStartChange = (value: 'sunday' | 'monday') => {
    setWeekStart(value);
    localStorage.setItem('weekStart', value);
    try { fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'weekStart', value }) }); } catch {}
    toast.info(`週の開始曜日を「${value === 'sunday' ? '日曜' : '月曜'}」に変更しました。`);
  };
  
  useEffect(() => {
    setMounted(true)
  }, [])
  useEffect(() => {
    // Fetch app and git info for display（ローカルキャッシュ→上書き）
    fetch('/api/app-info')
      .then((r) => r.json())
      .then((data) => { setAppInfo(data); try { localStorage.setItem('app.info', JSON.stringify(data)); } catch {} })
      .catch(() => {/* keep cached */})
  }, [])

  const handleSave = async () => {
    try {
      await onSaveColors();
      toast.success("色の設定を保存しました。");
    } catch (error) {
      toast.error("色の設定の保存に失敗しました。");
    }
  };

  const handleToggleYolo = async (on: boolean) => {
    setYoloMode(on);
    try { localStorage.setItem('tools.yolo', String(on)); } catch {}
    try {
      await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'tools.yolo', value: on }) });
      toast.success(on ? 'YOLOモードを有効化（自動許可）' : 'YOLOモードを無効化（実行前に確認）');
    } catch (e) {
      toast.error('設定の保存に失敗しました');
    }
  };

  const loadToolRules = async () => {
    try {
      const res = await fetch('/api/settings?keys=tools.allowAlways,tools.denyAlways');
      const data = await res.json();
      const s = data?.settings || {};
      setAllowAlways(Array.isArray(s['tools.allowAlways']) ? s['tools.allowAlways'] : []);
      setDenyAlways(Array.isArray(s['tools.denyAlways']) ? s['tools.denyAlways'] : []);
    } catch {}
  };
  const openRules = async () => { await loadToolRules(); setRulesOpen(true); };
  const removeRule = async (list: 'allow'|'deny', key: string) => {
    const arr = (list === 'allow' ? allowAlways : denyAlways).filter(k => k !== key);
    list === 'allow' ? setAllowAlways(arr) : setDenyAlways(arr);
    try {
      await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: list === 'allow' ? 'tools.allowAlways' : 'tools.denyAlways', value: arr }) });
    } catch {}
  };

  if (!mounted || !settingsLoaded) {
    return null
  }

  return (
    <div className="space-y-6 pt-16 lg:pt-0">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between space-y-4 lg:space-y-0">
        <div>
          <h1 className="text-3xl font-bold text-slate-800 dark:text-slate-100">設定</h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">アプリの設定をカスタマイズしましょう</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left Column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Tools / Approvals */}
          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800 dark:border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2 text-slate-800 dark:text-slate-200">
                <Shield className="w-5 h-5 text-red-600 dark:text-red-400" />
                <span>ツール実行の確認</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="yolo" className="text-base font-medium text-slate-800 dark:text-slate-200">
                    YOLOモード（自動許可）
                  </Label>
                  <p className="text-sm text-slate-600 dark:text-slate-400">オフにすると各ツール実行前に確認します</p>
                </div>
                <Switch id="yolo" checked={yoloMode} onCheckedChange={handleToggleYolo} />
              </div>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={openRules}>常時許可/拒否ルールを管理</Button>
              </div>

              {rulesOpen && (
                <div className="mt-3 p-3 border rounded-md dark:border-slate-700">
                  <div className="mb-2 text-sm font-semibold">常に許可</div>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {allowAlways.length === 0 && <span className="text-sm text-slate-500">（なし）</span>}
                    {allowAlways.map((k) => (
                      <span key={`allow-${k}`} className="inline-flex items-center gap-1 bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 px-2 py-1 rounded">
                        {k}
                        <button onClick={() => removeRule('allow', k)} className="ml-1 text-green-700 dark:text-green-300 hover:opacity-80">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="mb-2 text-sm font-semibold">常に拒否</div>
                  <div className="flex flex-wrap gap-2">
                    {denyAlways.length === 0 && <span className="text-sm text-slate-500">（なし）</span>}
                    {denyAlways.map((k) => (
                      <span key={`deny-${k}`} className="inline-flex items-center gap-1 bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 px-2 py-1 rounded">
                        {k}
                        <button onClick={() => removeRule('deny', k)} className="ml-1 text-red-700 dark:text-red-300 hover:opacity-80">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="flex justify-end mt-3">
                    <Button variant="ghost" size="sm" onClick={() => setRulesOpen(false)}>閉じる</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800 dark:border-slate-700">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center space-x-2 text-slate-800 dark:text-slate-200">
                <Palette className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                <span>教科ごとの色設定</span>
              </CardTitle>
              <Button onClick={handleSave} size="sm" className="bg-gradient-to-r from-blue-600 to-blue-700 text-white">
                <Save className="w-4 h-4 mr-2" />
                保存
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {uniqueSubjects.length > 0 ? (
                uniqueSubjects.map((subject) => (
                  <div key={subject} className="flex items-center justify-between">
                    <Badge
                      variant="outline"
                      className="text-base h-fit truncate"
                      style={getSubjectStyle(subject, subjectColors)}
                    >
                      {subject}
                    </Badge>
                    <Input
                      id={`color-${subject}`}
                      type="color"
                      value={subjectColors[subject] || '#000000'}
                      onChange={(e) => onColorChange(subject, e.target.value)}
                      className="w-12 h-12 p-1 rounded-md border-none cursor-pointer"
                      style={{ backgroundColor: subjectColors[subject] || '#000000' }}
                    />
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-500 dark:text-slate-400">まだ学習記録がありません。学習を開始すると教科が表示されます。</p>
              )}
            </CardContent>
          </Card>

          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800 dark:border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2 text-slate-800 dark:text-slate-200">
                <SettingsIcon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                <span>表示設定</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-base font-medium text-slate-800 dark:text-slate-200">「今週の学習時間」の集計期間</Label>
                <RadioGroup value={weeklyPeriod} onValueChange={handleWeeklyPeriodChange} className="mt-2 space-y-2">
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="this_week" id="this_week" />
                    <Label htmlFor="this_week" className="font-normal">今週（週次）</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="7_days" id="7_days" />
                    <Label htmlFor="7_days" className="font-normal">過去7日間</Label>
                  </div>
                </RadioGroup>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                  週次カードとグラフは上記の設定に連動します。月次カードは「直近30日間」の学習時間として表示されます（暦の月ではありません）。
                </p>
              </div>
              <div>
                <Label className="text-base font-medium text-slate-800 dark:text-slate-200">週の開始曜日</Label>
                <RadioGroup value={weekStart} onValueChange={(v) => handleWeekStartChange(v as any)} className="mt-2 space-y-2">
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="sunday" id="start_sun" />
                    <Label htmlFor="start_sun" className="font-normal">日曜始まり</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="monday" id="start_mon" />
                    <Label htmlFor="start_mon" className="font-normal">月曜始まり</Label>
                  </div>
                </RadioGroup>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">「今週」を選択中の集計に適用されます。</p>
              </div>
            </CardContent>
          </Card>

          {SHOW_TEMPLATES && (
            <Card className="border-0 shadow-lg bg-white dark:bg-slate-800 dark:border-slate-700">
              <CardHeader>
                <CardTitle className="flex items-center space-x-2 text-slate-800 dark:text-slate-200">
                  <User className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                  <span>プロフィール設定</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="firstName" className="dark:text-slate-200">名前</Label>
                    <Input id="firstName" defaultValue="田中" className="mt-1 dark:bg-slate-700 dark:text-slate-200 dark:border-slate-600" />
                  </div>
                  <div>
                    <Label htmlFor="lastName" className="dark:text-slate-200">姓</Label>
                    <Input id="lastName" defaultValue="太郎" className="mt-1 dark:bg-slate-700 dark:text-slate-200 dark:border-slate-600" />
                  </div>
                </div>
                <div>
                  <Label htmlFor="email" className="dark:text-slate-200">メールアドレス</Label>
                  <Input id="email" type="email" defaultValue="tanaka@example.com" className="mt-1 dark:bg-slate-700 dark:text-slate-200 dark:border-slate-600" />
                </div>
                <div>
                  <Label htmlFor="school" className="dark:text-slate-200">学校名</Label>
                  <Input id="school" defaultValue="○○高等学校" className="mt-1 dark:bg-slate-700 dark:text-slate-200 dark:border-slate-600" />
                </div>
                <div>
                  <Label htmlFor="grade" className="dark:text-slate-200">学年</Label>
                  <Input id="grade" defaultValue="3年生" className="mt-1 dark:bg-slate-700 dark:text-slate-200 dark:border-slate-600" />
                </div>
                <Button className="bg-gradient-to-r from-blue-600 to-blue-700 text-white">
                  <Save className="w-4 h-4 mr-2" />
                  プロフィールを保存
                </Button>
              </CardContent>
            </Card>
          )}

          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800 dark:border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2 text-slate-800 dark:text-slate-200">
                <Bell className="w-5 h-5 text-green-600 dark:text-green-400" />
                <span>通知設定</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="notifications" className="text-base font-medium text-slate-800 dark:text-slate-200">
                    プッシュ通知
                  </Label>
                  <p className="text-sm text-slate-600 dark:text-slate-400">アプリからの通知を受け取る</p>
                </div>
                <Switch id="notifications" checked={notifications} onCheckedChange={setNotifications} />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="studyReminders" className="text-base font-medium text-slate-800 dark:text-slate-200">
                    学習リマインダー
                  </Label>
                  <p className="text-sm text-slate-600 dark:text-slate-400">設定した時間に学習を促す通知</p>
                </div>
                <Switch id="studyReminders" checked={studyReminders} onCheckedChange={setStudyReminders} />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="weeklyReports" className="text-base font-medium text-slate-800 dark:text-slate-200">
                    週次レポート
                  </Label>
                  <p className="text-sm text-slate-600 dark:text-slate-400">毎週の学習サマリーを受け取る</p>
                </div>
                <Switch id="weeklyReports" checked={weeklyReports} onCheckedChange={setWeeklyReports} />
              </div>
            </CardContent>
          </Card>

          {SHOW_TEMPLATES && (
            <Card className="border-0 shadow-lg bg-white dark:bg-slate-800 dark:border-slate-700">
              <CardHeader>
                <CardTitle className="flex items-center space-x-2 text-slate-800 dark:text-slate-200">
                  <Palette className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                  <span>テーマ設定</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="darkMode" className="text-base font-medium text-slate-800 dark:text-slate-200">
                      ダークモード
                    </Label>
                    <p className="text-sm text-slate-600 dark:text-slate-400">暗いテーマに切り替える</p>
                  </div>
                  <Switch
                    id="darkMode"
                    checked={resolvedTheme === 'dark'}
                    onCheckedChange={(checked) => {
                      setTheme(checked ? 'dark' : 'light')
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {SHOW_TEMPLATES && (
            <Card className="border-0 shadow-lg bg-white dark:bg-slate-800 dark:border-slate-700">
              <CardHeader>
                <CardTitle className="flex items-center space-x-2 text-slate-800 dark:text-slate-200">
                  <Shield className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                  <span>データ管理</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  variant="outline"
                  className="w-full justify-start border-green-200 text-green-700 hover:bg-green-50 bg-transparent dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/50"
                >
                  <Download className="w-4 h-4 mr-2" />
                  データをエクスポート
                </Button>

                <Button
                  variant="outline"
                  className="w-full justify-start border-blue-200 text-blue-700 hover:bg-blue-50 bg-transparent dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-900/50"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  データをインポート
                </Button>

                <Button
                  variant="outline"
                  className="w-full justify-start border-red-200 text-red-700 hover:bg-red-50 bg-transparent dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/50"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  全データを削除
                </Button>
              </CardContent>
            </Card>
          )}

          {SHOW_TEMPLATES && (
            <Card className="border-0 shadow-lg bg-white dark:bg-slate-800 dark:border-slate-700">
              <CardHeader>
                <CardTitle className="flex items-center space-x-2 text-slate-800 dark:text-slate-200">
                  <SettingsIcon className="w-5 h-5 text-slate-600 dark:text-slate-400" />
                  <span>アカウント情報</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-slate-600 dark:text-slate-400">プラン</span>
                  <Badge className="bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/50 dark:text-blue-300 dark:border-blue-800">無料プラン</Badge>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-sm text-slate-600 dark:text-slate-400">登録日</span>
                  <span className="text-sm text-slate-800 dark:text-slate-200">2025年6月1日</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-sm text-slate-600 dark:text-slate-400">データ使用量</span>
                  <span className="text-sm text-slate-800 dark:text-slate-200">2.3 MB / 100 MB</span>
                </div>

                <Button className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 mt-4 text-white">
                  プレミアムにアップグレード
                </Button>
              </CardContent>
            </Card>
          )}

          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800 dark:border-slate-700">
            <CardHeader>
              <CardTitle className="text-base text-slate-800 dark:text-slate-200">アプリ情報</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">バージョン</span>
                <span className="text-slate-800 dark:text-slate-200">{appInfo?.version ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">最終更新</span>
                <span className="text-slate-800 dark:text-slate-200">{appInfo?.lastCommitDate ?? '—'}</span>
              </div>
              {appInfo?.git && (
                <div className="flex justify-between">
                  <span className="text-slate-600 dark:text-slate-400">Git</span>
                  <span className="text-slate-800 dark:text-slate-200">{`${appInfo.git.branch ?? '—'} @ ${appInfo.git.commit ?? '—'}`}</span>
                </div>
              )}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                <Link href="/legal/terms" className="text-blue-600 hover:underline dark:text-blue-400">利用規約</Link>
                <span className="text-slate-400">/</span>
                <Link href="/legal/privacy" className="text-blue-600 hover:underline dark:text-blue-400">プライバシーポリシー</Link>
                <span className="text-slate-400">/</span>
                <Link href="/legal/licenses" className="text-blue-600 hover:underline dark:text-blue-400">ライセンス</Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
