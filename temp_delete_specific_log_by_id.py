import sqlite3
import datetime
import os

DB_PATH = '/home/geminicli/GeminiCLI/study_log.db'

def delete_specific_break_event_by_id():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        today_date = datetime.date.today().strftime('%Y-%m-%d')
        
        # Find the ID of the specific BREAK event
        cursor.execute(
            "SELECT id FROM study_logs WHERE event_type = 'BREAK' AND start_time LIKE ? AND duration_minutes = 0 AND content IS NULL AND subject IS NULL ORDER BY id DESC LIMIT 1",
            ("{}".format(today_date + " 17:12%"),)
        )
        log_id_result = cursor.fetchone()
        log_id_to_delete = log_id_result[0] if log_id_result else None

        if log_id_to_delete:
            cursor.execute(
                "DELETE FROM study_logs WHERE id = ?",
                (log_id_to_delete,)
            )
            conn.commit()
            print("Log entry (ID: {}) deleted successfully.".format(log_id_to_delete))
        else:
            print("No matching log entry found to delete.")

    except Exception as e:
        print("Error deleting log entry: {}".format(e))
        conn.rollback()
    finally:
        conn.close()

if __name__ == '__main__':
    delete_specific_break_event_by_id()
