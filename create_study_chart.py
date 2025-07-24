# -*- coding: utf-8 -*-
import sqlite3
import datetime
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
import os

# Clear matplotlib font cache and rebuild


def create_pie_chart(db_path, output_dir):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    today_date = datetime.date.today().strftime('%Y-%m-%d')

    cursor.execute("SELECT subject, start_time, end_time FROM study_logs WHERE event_type = 'START' AND DATE(start_time) = '{}'".format(today_date))
    logs = cursor.fetchall()
    conn.close()

    subject_durations = {}
    for log in logs:
        subject = log[0]
        start_time_str = log[1]
        end_time_str = log[2]

        if start_time_str and end_time_str:
            start_time = datetime.datetime.strptime(start_time_str, '%Y-%m-%d %H:%M:%S')
            end_time = datetime.datetime.strptime(end_time_str, '%Y-%m-%d %H:%M:%S')
            duration_seconds = (end_time - start_time).total_seconds()
            subject_durations[subject] = subject_durations.get(subject, 0) + duration_seconds

    if not subject_durations:
        print("No study logs found for today.")
        return

    labels = []
    sizes = []
    for subject, duration in subject_durations.items():
        labels.append("{0} ({1}分)".format(subject, int(duration / 60)))
        sizes.append(duration)

    # Set font to a generic sans-serif that might support Japanese
    # Explicitly add IPA Gothic font
    font_path = '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf'
    fm.fontManager.addfont(font_path)
    prop = fm.FontProperties(fname=font_path)
    plt.rcParams['font.family'] = prop.get_name()
    plt.rcParams['font.sans-serif'] = [prop.get_name(), "DejaVu Sans", "Arial Unicode MS"]

    fig1, ax1 = plt.subplots()
    ax1.pie(sizes, labels=labels, autopct='%1.1f%%', startangle=90)
    ax1.axis('equal')  # Equal aspect ratio ensures that pie is drawn as a circle.

    output_filename = "study_pie_chart_{}.png".format(today_date)
    output_path = os.path.join(output_dir, output_filename)
    plt.savefig(output_path)
    print("Pie chart saved to: {}".format(output_path))

if __name__ == "__main__":
    db_path = "/home/geminicli/GeminiCLI/study_log.db"
    output_dir = "/home/geminicli/GeminiCLI/db_backups"
    create_pie_chart(db_path, output_dir)