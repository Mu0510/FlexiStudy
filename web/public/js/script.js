// Dashboard specific JavaScript
        document.addEventListener('DOMContentLoaded', () => {
            console.log("DOMContentLoaded event fired. Script is running!"); // 追加
            let currentDate = new Date();
            const datePicker = document.getElementById('date-picker');
            const dateText = document.getElementById('date-text');
            const dailySummaryContainer = document.getElementById('daily-summary-container');
            const dailyGoalContainer = document.getElementById('daily-goal-container');
            const logsContainer = document.getElementById('logs-container');

            const formatDate = (date) => {
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            };

            const displayFormattedDate = (date) => {
                dateText.textContent = date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
                datePicker.value = formatDate(date);
            };

            const fetchAndDisplayLogs = async (dateString) => {
                logsContainer.innerHTML = '<p>読み込み中...</p>';
                dailySummaryContainer.innerHTML = '';
                dailyGoalContainer.innerHTML = '';
                try {
                    const response = await fetch(`/run-python-script?date=${dateString}`);
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                    const data = await response.json();

                    // Display daily summary
                    const summaryHours = Math.floor(data.total_day_study_minutes / 60);
                    const summaryMins = data.total_day_study_minutes % 60;
                    const durationText = `${summaryHours}時間${summaryMins}分`;
                    const subjectsHtml = data.subjects_studied.map(s => `<span class="subject-badge">${s}</span>`).join(' ');

                    // Display daily goal
                    if (data.daily_goal && data.daily_goal.length > 0) {
                        let groupedGoals = {};
                        data.daily_goal.forEach(goal => {
                            if (!groupedGoals[goal.subject]) {
                                groupedGoals[goal.subject] = {
                                    totalCount: 0,
                                    items: []
                                };
                            }
                            if (typeof goal.count === 'number') { // countが存在する場合のみ加算
                                groupedGoals[goal.subject].totalCount += goal.count;
                            }
                            groupedGoals[goal.subject].items.push(goal);
                        });

                        let goalHtml = '<h4>今日の目標</h4><ul class="goal-list">';
                        for (const subject in groupedGoals) {
                            const group = groupedGoals[subject];
                            const totalCountDisplay = group.totalCount > 0 ? ` (計${group.totalCount}問)` : '';
                            goalHtml += `<li>${subject}${totalCountDisplay}<ul>`;
                            group.items.forEach(item => {
                                const itemDetails = item.details && typeof item.count === 'number' ? `${item.details} (${item.count}問)` : item.target;
                                goalHtml += `<li class="${item.completed ? 'completed-goal' : ''}">${itemDetails}</li>`;
                            });
                            goalHtml += `</ul></li>`;
                        }
                        goalHtml += '</ul>';

                        dailyGoalContainer.innerHTML = `
                            <div id="daily-goal-content" class="daily-goal-content">
                                ${goalHtml}
                            </div>
                        `;
                    } else {
                        dailyGoalContainer.innerHTML = '<p>今日の目標は設定されていません。</p>';
                    }

                    dailySummaryContainer.innerHTML = `
                        <p>${data.daily_summary || 'この日のまとめはありません。'}</p>
                        <div class="daily-summary-grid">
                            <div class="daily-summary-item">
                                <h4>合計学習時間</h4>
                                <span class="duration-value">${durationText}</span>
                            </div>
                            <div class="daily-summary-item">
                                <h4>学習教科</h4>
                                <div>${subjectsHtml || 'なし'}</div>
                            </div>
                        </div>
                    `;

                    // Display sessions
                    logsContainer.innerHTML = '';
                    if (!data.sessions || data.sessions.length === 0) {
                        logsContainer.innerHTML = `<p>${dateString} の学習記録はありません。</p>`;
                        
                        return;
                    }

                    data.sessions.forEach(session => {
                        const detailsElement = document.createElement('details');
                        detailsElement.open = false;
                        const summaryElement = document.createElement('summary');
                        const summaryContent = document.createElement('div');
                        summaryContent.className = 'summary-content';

                        const line1 = document.createElement('div');
                        line1.className = 'summary-line-1';
                        const sessionHours = Math.floor(session.total_study_minutes / 60);
                        const sessionMins = session.total_study_minutes % 60;
                        const sessionDurationText = `${sessionHours}時間${sessionMins}分`;
                        line1.innerHTML = `
                            <span><strong>${session.subject}</strong><span class="session-id">(ID: ${session.session_id})</span></span>
                            <span>${session.session_start_time} - ${session.session_end_time}</span>
                            <span><strong>合計:</strong> ${sessionDurationText}</span>
                        `;

                        const line2 = document.createElement('div');
                        line2.className = 'summary-line-2';
                        line2.textContent = session.summary || 'セッションの概要はありません。';

                        summaryContent.appendChild(line1);
                        summaryContent.appendChild(line2);
                        summaryElement.appendChild(summaryContent);
                        detailsElement.appendChild(summaryElement);

                        const table = document.createElement('table');
                        table.className = 'session-details-table';
                        table.innerHTML = `<thead><tr><th>イベント</th><th>継続時間</th><th>内容</th><th>開始</th><th>終了</th></tr></thead><tbody></tbody>`;
                        const tbody = table.querySelector('tbody');
                        session.details.forEach(detail => {
                            const row = tbody.insertRow();
                            row.innerHTML = `
                                <td><span class="event-type event-${detail.event_type}">${detail.event_type}</span></td>
                                <td>${detail.duration_minutes !== null ? `${detail.duration_minutes} 分` : ''}</td>
                                <td>${detail.content || ''}</td>
                                <td>${detail.start_time || ''}</td>
                                <td>${detail.end_time || ''}</td>
                            `;
                        });
                        detailsElement.appendChild(table);
                        logsContainer.appendChild(detailsElement);
                    });
                } catch (error) {
                    console.error('ログの取得に失敗しました:', error);
                    logsContainer.innerHTML = '<p>ログの読み込みに失敗しました。サーバーが起動しているか確認してください。</p>';
                }
            };

            const updateDate = (newDate) => {
                currentDate = newDate;
                displayFormattedDate(currentDate);
                fetchAndDisplayLogs(formatDate(currentDate));
            };

            document.getElementById('prev-day').addEventListener('click', () => updateDate(new Date(currentDate.setDate(currentDate.getDate() - 1))));
            document.getElementById('next-day').addEventListener('click', () => updateDate(new Date(currentDate.setDate(currentDate.getDate() + 1))));
            datePicker.addEventListener('change', (e) => {
                const [year, month, day] = e.target.value.split('-').map(Number);
                updateDate(new Date(year, month - 1, day));
            });
            
            document.getElementById('current-date-display').addEventListener('click', () => {
                try {
                    datePicker.showPicker();
                } catch (e) {
                    console.error("datePicker.showPicker() is not supported in this browser.", e);
                }
            });

            updateDate(currentDate);
        });