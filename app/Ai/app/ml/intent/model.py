"""Intent Classifier class wrapping TfidfVectorizer and LogisticRegression."""

import joblib
from typing import List, Dict, Any, Tuple
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline

from app.ml.intent.preprocessing import preprocess_text_for_intent
from app.ml.common.utils import get_model_path


class IntentClassifier:
    """Scikit-learn pipeline for multi-class customer intent classification."""

    DEFAULT_MODEL_FILENAME = "intent_model.joblib"

    def __init__(self) -> None:
        self.pipeline: Pipeline = Pipeline([
            ("tfidf", TfidfVectorizer(preprocessor=preprocess_text_for_intent, max_features=5000)),
            ("clf", LogisticRegression(max_iter=1000, C=1.0)),
        ])
        self.is_fitted: bool = False

    def train(self, texts: List[str], labels: List[str]) -> Dict[str, Any]:
        """Train TF-IDF + Logistic Regression model on labeled text dataset."""
        if not texts or not labels:
            raise ValueError("Training data and labels must not be empty.")

        self.pipeline.fit(texts, labels)
        self.is_fitted = True

        return {
            "num_samples": len(texts),
            "classes": list(self.pipeline.classes_),
            "status": "trained",
        }

    def predict(self, text: str) -> str:
        """Predict top intent label for input text string."""
        if not self.is_fitted:
            return "general_inquiry"
        return str(self.pipeline.predict([text])[0])

    def predict_proba(self, text: str) -> Dict[str, float]:
        """Predict class probability distribution for input text string."""
        if not self.is_fitted:
            return {"general_inquiry": 1.0}

        classes = self.pipeline.classes_
        probs = self.pipeline.predict_proba([text])[0]
        return {str(cls): float(prob) for cls, prob in zip(classes, probs)}

    def save(self, filename: str = DEFAULT_MODEL_FILENAME) -> str:
        """Save fitted model pipeline to disk using joblib."""
        if not self.is_fitted:
            raise RuntimeError("Cannot save an unfitted model.")
        save_path = get_model_path(filename)
        joblib.dump(self.pipeline, save_path)
        return str(save_path)

    def load(self, filename: str = DEFAULT_MODEL_FILENAME) -> bool:
        """Load fitted model pipeline from disk using joblib."""
        model_path = get_model_path(filename)
        if not model_path.exists():
            return False

        try:
            self.pipeline = joblib.load(model_path)
            self.is_fitted = True
            return True
        except Exception:
            self.is_fitted = False
            return False
