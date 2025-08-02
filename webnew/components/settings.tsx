"use client"

import { useState, useEffect } from "react"
import { useTheme } from "next-themes"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { SettingsIcon, User, Bell, Palette, Shield, Download, Upload, Trash2, Save } from "lucide-react"

export function Settings() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [notifications, setNotifications] = useState(true)
  const [studyReminders, setStudyReminders] = useState(true)
  const [weeklyReports, setWeeklyReports] = useState(true)

  // useEffect only runs on the client, so we can safely show the UI
  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return null // or a loading skeleton
  }

  return (
    <div className="space-y-6 pt-16 lg:pt-0">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between space-y-4 lg:space-y-0">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">設定</h1>
          <p className="text-slate-600 mt-1">アプリの設定をカスタマイズしましょう</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Profile Settings */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-0 shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <User className="w-5 h-5 text-blue-600" />
                <span>プロフィール設定</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="firstName">名前</Label>
                  <Input id="firstName" defaultValue="田中" className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="lastName">姓</Label>
                  <Input id="lastName" defaultValue="太郎" className="mt-1" />
                </div>
              </div>
              <div>
                <Label htmlFor="email">メールアドレス</Label>
                <Input id="email" type="email" defaultValue="tanaka@example.com" className="mt-1" />
              </div>
              <div>
                <Label htmlFor="school">学校名</Label>
                <Input id="school" defaultValue="○○高等学校" className="mt-1" />
              </div>
              <div>
                <Label htmlFor="grade">学年</Label>
                <Input id="grade" defaultValue="3年生" className="mt-1" />
              </div>
              <Button className="bg-gradient-to-r from-blue-600 to-blue-700">
                <Save className="w-4 h-4 mr-2" />
                プロフィールを保存
              </Button>
            </CardContent>
          </Card>

          {/* Notification Settings */}
          <Card className="border-0 shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Bell className="w-5 h-5 text-green-600" />
                <span>通知設定</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="notifications" className="text-base font-medium">
                    プッシュ通知
                  </Label>
                  <p className="text-sm text-slate-600">アプリからの通知を受け取る</p>
                </div>
                <Switch id="notifications" checked={notifications} onCheckedChange={setNotifications} />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="studyReminders" className="text-base font-medium">
                    学習リマインダー
                  </Label>
                  <p className="text-sm text-slate-600">設定した時間に学習を促す通知</p>
                </div>
                <Switch id="studyReminders" checked={studyReminders} onCheckedChange={setStudyReminders} />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="weeklyReports" className="text-base font-medium">
                    週次レポート
                  </Label>
                  <p className="text-sm text-slate-600">毎週の学習サマリーを受け取る</p>
                </div>
                <Switch id="weeklyReports" checked={weeklyReports} onCheckedChange={setWeeklyReports} />
              </div>
            </CardContent>
          </Card>

          {/* Theme Settings */}
          <Card className="border-0 shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Palette className="w-5 h-5 text-purple-600" />
                <span>テーマ設定</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="darkMode" className="text-base font-medium">
                    ダークモード
                  </Label>
                  <p className="text-sm text-slate-600">暗いテーマに切り替える</p>
                </div>
                <Switch
                  id="darkMode"
                  checked={resolvedTheme === 'dark'}
                  onCheckedChange={(checked) => {
                    setTheme(checked ? 'dark' : 'light')
                  }}
                />
              </div>

              <div>
                <Label className="text-base font-medium mb-3 block">アクセントカラー</Label>
                <div className="grid grid-cols-6 gap-3">
                  {["bg-blue-500", "bg-green-500", "bg-purple-500", "bg-pink-500", "bg-orange-500", "bg-red-500"].map(
                    (color, index) => (
                      <button
                        key={index}
                        className={`w-10 h-10 rounded-lg ${color} border-2 border-transparent hover:border-slate-300 transition-colors`}
                      />
                    ),
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Data Management */}
        <div className="space-y-6">
          <Card className="border-0 shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Shield className="w-5 h-5 text-orange-600" />
                <span>データ管理</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                variant="outline"
                className="w-full justify-start border-green-200 text-green-700 hover:bg-green-50 bg-transparent"
              >
                <Download className="w-4 h-4 mr-2" />
                データをエクスポート
              </Button>

              <Button
                variant="outline"
                className="w-full justify-start border-blue-200 text-blue-700 hover:bg-blue-50 bg-transparent"
              >
                <Upload className="w-4 h-4 mr-2" />
                データをインポート
              </Button>

              <Button
                variant="outline"
                className="w-full justify-start border-red-200 text-red-700 hover:bg-red-50 bg-transparent"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                全データを削除
              </Button>
            </CardContent>
          </Card>

          {/* Account Info */}
          <Card className="border-0 shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <SettingsIcon className="w-5 h-5 text-slate-600" />
                <span>アカウント情報</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-600">プラン</span>
                <Badge className="bg-blue-100 text-blue-800 border-blue-200">無料プラン</Badge>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-600">登録日</span>
                <span className="text-sm text-slate-800">2025年6月1日</span>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-600">データ使用量</span>
                <span className="text-sm text-slate-800">2.3 MB / 100 MB</span>
              </div>

              <Button className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 mt-4">
                プレミアムにアップグレード
              </Button>
            </CardContent>
          </Card>

          {/* App Info */}
          <Card className="border-0 shadow-lg">
            <CardHeader>
              <CardTitle className="text-base">アプリ情報</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">バージョン</span>
                <span className="text-slate-800">2.1.0</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">最終更新</span>
                <span className="text-slate-800">2025年7月20日</span>
              </div>
              <Button variant="link" className="p-0 h-auto text-blue-600 text-sm">
                利用規約・プライバシーポリシー
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
