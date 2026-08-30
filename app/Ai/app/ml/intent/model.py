"""Intent Classifier class wrapping TfidfVectorizer and LogisticRegression."""

import joblib
from typing import List, Dict, Any, Tuple
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

from app.ml.intent.preprocessing import preprocess_text_for_intent
from app.ml.common.utils import get_model_path


class IntentClassifier:
    """Scikit-learn wrapper for multi-class customer intent classification."""

    DEFAULT_CLASSIFIER_FILENAME = "intent_classifier.joblib"
    DEFAULT_VECTORIZER_FILENAME = "tfidf_vectorizer.joblib"

    def __init__(self) -> None:
        self.vectorizer = TfidfVectorizer(preprocessor=preprocess_text_for_intent, max_features=5000)
        self.clf = LogisticRegression(max_iter=1000, C=1.0)
        self.is_fitted: bool = False

    def train(self, texts: List[str], labels: List[str]) -> Dict[str, Any]:
        """Train TF-IDF + Logistic Regression model on labeled text dataset."""
        if not texts or not labels:
            raise ValueError("Training data and labels must not be empty.")

        X = self.vectorizer.fit_transform(texts)
        self.clf.fit(X, labels)
        self.is_fitted = True

        return {
            "num_samples": len(texts),
            "classes": list(self.clf.classes_),
            "status": "trained",
        }

    def predict(self, text: str) -> str:
        """Predict top intent label for input text string."""
        if not self.is_fitted:
            return "GENERAL_SUPPORT"
            
        X = self.vectorizer.transform([text])
        return str(self.clf.predict(X)[0])

    def predict_proba(self, text: str) -> Dict[str, float]:
        """Predict class probability distribution for input text string."""
        if not self.is_fitted:
            return {"GENERAL_SUPPORT": 1.0}

        X = self.vectorizer.transform([text])
        classes = self.clf.classes_
        probs = self.clf.predict_proba(X)[0]
        return {str(cls): float(prob) for cls, prob in zip(classes, probs)}
        
    def get_classes(self) -> List[str]:
        """Return the list of classes the model was trained on."""
        if not self.is_fitted:
            return []
        return list(self.clf.classes_)

    def save(self, clf_filename: str = DEFAULT_CLASSIFIER_FILENAME, vec_filename: str = DEFAULT_VECTORIZER_FILENAME) -> Tuple[str, str]:
        """Save fitted model and vectorizer to disk using joblib."""
        if not self.is_fitted:
            raise RuntimeError("Cannot save an unfitted model.")
            
        clf_path = get_model_path(clf_filename)
        vec_path = get_model_path(vec_filename)
        
        joblib.dump(self.clf, clf_path)
        joblib.dump(self.vectorizer, vec_path)
        
        return str(clf_path), str(vec_path)

    def load(self, clf_filename: str = DEFAULT_CLASSIFIER_FILENAME, vec_filename: str = DEFAULT_VECTORIZER_FILENAME) -> bool:
        """Load fitted model and vectorizer from disk using joblib."""
        clf_path = get_model_path(clf_filename)
        vec_path = get_model_path(vec_filename)
        
        if not clf_path.exists() or not vec_path.exists():
            return False

        try:
            self.clf = joblib.load(clf_path)
            self.vectorizer = joblib.load(vec_path)
            self.is_fitted = True
            return True
        except Exception:
            self.is_fitted = False
            return False
