"""Evaluation script for Intent Classification Model."""

import pandas as pd
from pathlib import Path
from typing import Dict, Any
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, classification_report
from sklearn.model_selection import train_test_split

from app.ml.intent.model import IntentClassifier


def evaluate_model() -> Dict[str, Any]:
    """Evaluate the intent classification model."""
    classifier = IntentClassifier()
    if not classifier.load():
        return {"status": "error", "message": "Model not found. Please train first."}

    current_dir = Path(__file__).resolve().parent
    data_path = current_dir / "training_data.csv"
    
    if not data_path.exists():
        return {"status": "error", "message": f"Data not found at {data_path}"}
        
    df = pd.read_csv(data_path)
    df = df.dropna(subset=["text", "label"])
    
    texts = df["text"].tolist()
    labels = df["label"].tolist()
    
    # We evaluate on the test split (same random state as train)
    _, X_test, _, y_test = train_test_split(
        texts, labels, test_size=0.2, random_state=42, stratify=labels
    )
    
    X_test_vec = classifier.vectorizer.transform(X_test)
    y_pred = classifier.clf.predict(X_test_vec)
    
    acc = accuracy_score(y_test, y_pred)
    prec = precision_score(y_test, y_pred, average="weighted", zero_division=0)
    rec = recall_score(y_test, y_pred, average="weighted", zero_division=0)
    f1 = f1_score(y_test, y_pred, average="weighted", zero_division=0)
    
    report = classification_report(y_test, y_pred, output_dict=True, zero_division=0)
    
    return {
        "status": "success",
        "model_status": "trained",
        "accuracy": round(acc, 4),
        "precision": round(prec, 4),
        "recall": round(rec, 4),
        "f1_score": round(f1, 4),
        "classification_report": report,
    }


if __name__ == "__main__":
    result = evaluate_model()
    import json
    print(json.dumps(result, indent=2))
