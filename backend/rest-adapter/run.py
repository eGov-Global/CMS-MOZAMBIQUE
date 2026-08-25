"""Development entrypoint. Production runs `gunicorn 'run:app'`."""

from dotenv import load_dotenv

load_dotenv()

from app import create_app
from app.config import load_config

config = load_config()
app = create_app(config)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=config.port)
